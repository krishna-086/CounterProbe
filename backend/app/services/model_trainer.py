"""
Model training and single-row prediction.

Trains the scikit-learn RandomForest that the probe engine then attacks. The
model and its preprocessing pipeline are bundled together so probes — which
fire predict_single() hundreds of times — get the exact same encoding the
model saw during training. Inconsistent preprocessing between train and
predict is the single most common source of silently-wrong probe results,
which is why the preprocessing info travels with the model.

Public API:
    train_model(df, target_column, feature_columns)
        -> (sklearn_model, test_accuracy, feature_importances_by_original_name)

    predict_single(model, preprocessing_info, row_dict)
        -> probability of the positive class as a float in [0, 1]

When predict_single is called with preprocessing_info=None, the preprocessing
attached to the model during training is used instead. This lets callers stay
ergonomic without losing the option to override.
"""

from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

PREPROCESSING_ATTR = "_fairlens_preprocessing"


def _split_feature_types(
    df: pd.DataFrame, feature_columns: List[str]
) -> Tuple[List[str], List[str]]:
    numeric, categorical = [], []
    for col in feature_columns:
        series = df[col]
        if pd.api.types.is_bool_dtype(series) or not pd.api.types.is_numeric_dtype(series):
            categorical.append(col)
        else:
            numeric.append(col)
    return numeric, categorical


def _preprocess_frame(
    frame: pd.DataFrame,
    numeric_columns: List[str],
    categorical_columns: List[str],
    numeric_medians: Dict[str, float],
    encoded_columns: List[str] | None = None,
) -> pd.DataFrame:
    """Fill NaNs, one-hot encode, then align to encoded_columns if provided."""
    out = frame.copy()
    for col in numeric_columns:
        out[col] = pd.to_numeric(out[col], errors="coerce").fillna(numeric_medians[col])
    for col in categorical_columns:
        out[col] = out[col].astype(str)
    if categorical_columns:
        out = pd.get_dummies(out, columns=categorical_columns, dummy_na=False)
    if encoded_columns is not None:
        out = out.reindex(columns=encoded_columns, fill_value=0)
    return out


def _aggregate_importances(
    raw_importances: np.ndarray,
    encoded_columns: List[str],
    numeric_columns: List[str],
    categorical_columns: List[str],
) -> Dict[str, float]:
    """Sum one-hot derived importances back under their original feature name."""
    importances: Dict[str, float] = {col: 0.0 for col in numeric_columns + categorical_columns}
    for encoded_name, importance in zip(encoded_columns, raw_importances):
        if encoded_name in importances:
            importances[encoded_name] += float(importance)
            continue
        # one-hot column: original_name + "_" + value
        for cat in categorical_columns:
            if encoded_name.startswith(f"{cat}_"):
                importances[cat] += float(importance)
                break
    return importances


def train_model(
    df: pd.DataFrame, target_column: str, feature_columns: List[str]
) -> Tuple[RandomForestClassifier, float, Dict[str, float]]:
    """
    Fit a RandomForestClassifier (n_estimators=100, random_state=42) on an
    80/20 split of the supplied DataFrame.

    Returns the fitted model, its test-set accuracy, and a feature-importance
    dict keyed by ORIGINAL feature name (one-hot derived columns are summed
    back into their parent column).

    The preprocessing pipeline is attached to the model as a private attribute
    so predict_single() can reapply identical encoding to probe rows.
    """
    if target_column not in df.columns:
        raise ValueError(f"target_column '{target_column}' is not in the DataFrame.")
    missing = [c for c in feature_columns if c not in df.columns]
    if missing:
        raise ValueError(f"feature_columns not in DataFrame: {missing}")
    if target_column in feature_columns:
        feature_columns = [c for c in feature_columns if c != target_column]
    if not feature_columns:
        raise ValueError("feature_columns is empty after removing target_column.")

    work = df[feature_columns + [target_column]].dropna(subset=[target_column]).copy()
    if work.empty:
        raise ValueError("No rows remain after dropping null targets.")

    numeric_columns, categorical_columns = _split_feature_types(work, feature_columns)
    numeric_medians = {col: float(pd.to_numeric(work[col], errors="coerce").median()) for col in numeric_columns}
    for col in numeric_medians:
        if pd.isna(numeric_medians[col]):
            numeric_medians[col] = 0.0

    X = _preprocess_frame(
        work[feature_columns], numeric_columns, categorical_columns, numeric_medians
    )
    encoded_columns = list(X.columns)
    y = work[target_column].to_numpy()

    test_size = 0.2 if len(X) >= 5 else max(1, len(X) // 5) / len(X)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=42
    )

    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)
    accuracy = float(model.score(X_test, y_test))

    importances = _aggregate_importances(
        model.feature_importances_, encoded_columns, numeric_columns, categorical_columns
    )

    setattr(
        model,
        PREPROCESSING_ATTR,
        {
            "feature_columns": list(feature_columns),
            "numeric_columns": numeric_columns,
            "categorical_columns": categorical_columns,
            "numeric_medians": numeric_medians,
            "encoded_columns": encoded_columns,
        },
    )

    return model, accuracy, importances


def predict_single(
    model: RandomForestClassifier,
    preprocessing_info: Dict[str, Any] | None,
    row_dict: Dict[str, Any],
) -> float:
    """
    Predict the probability of the positive class for a single row.

    If preprocessing_info is None, the pipeline attached to `model` during
    training is used. Returns a float in [0, 1].
    """
    info = preprocessing_info or getattr(model, PREPROCESSING_ATTR, None)
    if info is None:
        raise ValueError(
            "No preprocessing info available. Either pass it explicitly or train "
            "the model via train_model() so it gets attached automatically."
        )

    feature_columns = info["feature_columns"]
    row = {col: row_dict.get(col, np.nan) for col in feature_columns}
    frame = pd.DataFrame([row], columns=feature_columns)

    encoded = _preprocess_frame(
        frame,
        info["numeric_columns"],
        info["categorical_columns"],
        info["numeric_medians"],
        encoded_columns=info["encoded_columns"],
    )

    proba = model.predict_proba(encoded)[0]
    classes = list(model.classes_)
    if len(classes) == 1:
        return 1.0 if classes[0] in (1, True, "1", "yes", "true") else 0.0
    # Positive class = the class that sorts last (works for {0,1}, {False,True}, {'no','yes'})
    positive_idx = int(np.argmax([str(c) for c in classes]))
    return float(proba[positive_idx])
