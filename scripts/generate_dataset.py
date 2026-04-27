"""
Generate a 2000-row synthetic hiring dataset for FairLens demos.

The dataset has a *baked-in proxy bias*: candidate names are drawn from
multiple Faker locales and the demographic group inferred from the locale
shifts the distribution of `university_tier`. The hire decision then depends
explicitly on `university_tier` (with no direct dependency on name or
gender), creating the indirect causal path:

    name -> demographic group -> university_tier -> hired

That's exactly the kind of proxy variable FairLens is designed to detect.

Output: backend/demo_data/hiring_data.csv

Run from project root:
    python scripts/generate_dataset.py
"""

import random
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd
from faker import Faker

SEED = 42
NUM_ROWS = 2000

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = PROJECT_ROOT / "backend" / "demo_data" / "hiring_data.csv"

# ----- Locale mix (shapes name diversity) ----------------------------------
LOCALE_WEIGHTS: Dict[str, float] = {
    "en_US": 0.30,
    "en_GB": 0.10,
    "es_ES": 0.07,
    "es_MX": 0.08,
    "zh_CN": 0.12,
    "ja_JP": 0.04,
    "ko_KR": 0.04,
    "hi_IN": 0.12,
    "fr_FR": 0.05,
    "de_DE": 0.05,
    "ru_RU": 0.03,
}

# ----- Demographic groupings (used ONLY at generation time) ----------------
GROUP_OF: Dict[str, str] = {
    "en_US": "anglo", "en_GB": "anglo",
    "es_ES": "hispanic", "es_MX": "hispanic",
    "zh_CN": "east_asian", "ja_JP": "east_asian", "ko_KR": "east_asian",
    "hi_IN": "south_asian",
    "fr_FR": "european", "de_DE": "european", "ru_RU": "european",
}

# Per-group probability over [tier1, tier2, tier3]. Skew creates the proxy bias.
TIER_WEIGHTS: Dict[str, List[float]] = {
    "anglo":       [0.40, 0.35, 0.25],
    "east_asian":  [0.40, 0.35, 0.25],
    "european":    [0.35, 0.35, 0.30],
    "south_asian": [0.25, 0.35, 0.40],
    "hispanic":    [0.20, 0.35, 0.45],
}

# ----- University pools per tier --------------------------------------------
TIER_1_UNIS = [
    "Harvard University", "MIT", "Stanford University", "Yale University",
    "Princeton University", "California Institute of Technology",
    "Columbia University", "University of Chicago", "University of Pennsylvania",
    "Cornell University", "UC Berkeley", "Brown University", "Dartmouth College",
    "Northwestern University", "Duke University", "Johns Hopkins University",
    "University of Oxford", "University of Cambridge", "Imperial College London",
    "ETH Zurich", "Tsinghua University", "Peking University",
    "IIT Bombay", "IIT Delhi", "IIT Madras",
    "National University of Singapore", "University of Tokyo", "Seoul National University",
]
TIER_2_UNIS = [
    "New York University", "USC", "UCLA", "University of Michigan",
    "University of Virginia", "Georgia Tech", "UT Austin",
    "University of Wisconsin-Madison", "Boston University",
    "Carnegie Mellon University", "Northeastern University", "Vanderbilt University",
    "Emory University", "Washington University in St. Louis",
    "University of Notre Dame", "Tufts University", "Rice University",
    "King's College London", "University of Edinburgh", "University of Manchester",
    "University of Toronto", "McGill University", "TU Munich", "HKUST",
    "KAIST", "Fudan University", "Delhi University", "Sciences Po",
]
TIER_3_UNIS = [
    "Arizona State University", "San Diego State University",
    "Cal State Long Beach", "Florida State University",
    "Cleveland State University", "Wayne State University",
    "University of Phoenix", "Liberty University", "DeVry University",
    "Cal Poly Pomona", "San Jose State University",
    "University of Houston-Downtown", "Eastern Michigan University",
    "Kennesaw State University", "Old Dominion University",
    "Indiana State University", "University of Memphis",
    "Northern Arizona University", "Western Kentucky University",
    "South Dakota State University",
]
UNIS_BY_TIER = {1: TIER_1_UNIS, 2: TIER_2_UNIS, 3: TIER_3_UNIS}

CITIES = [
    "New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia",
    "San Antonio", "San Diego", "Dallas", "Austin", "San Jose", "Seattle",
    "Boston", "Atlanta", "Miami", "Denver", "Washington", "Minneapolis",
    "Portland", "Detroit", "Charlotte", "San Francisco", "Pittsburgh", "Nashville",
]


def _seed_everything() -> None:
    random.seed(SEED)
    np.random.seed(SEED)
    Faker.seed(SEED)


def _build_fakers() -> Dict[str, Faker]:
    fakers = {loc: Faker(loc) for loc in LOCALE_WEIGHTS}
    for i, loc in enumerate(LOCALE_WEIGHTS):
        fakers[loc].seed_instance(SEED + i)
    return fakers


def _faker_name(f: Faker, gender: str) -> str:
    """Return a gendered name; fall back to neutral name() if locale lacks the helper."""
    try:
        return f.name_male() if gender == "Male" else f.name_female()
    except AttributeError:
        return f.name()


def _generate_row(fakers: Dict[str, Faker]) -> Dict[str, Any]:
    locale = random.choices(
        list(LOCALE_WEIGHTS.keys()), weights=list(LOCALE_WEIGHTS.values()), k=1
    )[0]
    group = GROUP_OF[locale]
    gender = random.choice(["Male", "Female"])
    name = _faker_name(fakers[locale], gender)

    age = int(np.clip(np.random.normal(32, 8), 22, 58))
    tier = int(np.random.choice([1, 2, 3], p=TIER_WEIGHTS[group]))
    university = random.choice(UNIS_BY_TIER[tier])
    gpa = round(float(np.clip(np.random.normal(3.3, 0.4), 2.5, 4.0)), 2)
    years_experience = int(
        np.clip(np.random.normal(max(age - 22, 0) / 2, 3), 0, 25)
    )
    skills_score = int(np.clip(np.random.normal(72, 12), 40, 100))
    certifications = int(
        np.random.choice([0, 1, 2, 3, 4, 5], p=[0.20, 0.25, 0.20, 0.15, 0.12, 0.08])
    )
    city = random.choice(CITIES)
    interview_score = int(np.clip(np.random.normal(6.5, 1.5), 3, 10))

    return {
        "name": name,
        "gender": gender,
        "age": age,
        "university": university,
        "university_tier": tier,
        "gpa": gpa,
        "years_experience": years_experience,
        "skills_score": skills_score,
        "certifications": certifications,
        "city": city,
        "interview_score": interview_score,
        "_group": group,  # internal, dropped before write
    }


# Tuned so the overall hire rate lands in the target 40-50% band when the
# threshold stays at 0.5 (per the prompt). Without it the formula averages
# ~0.61 because every weighted feature mean hovers above 0.5.
BASE_PROB_OFFSET = -0.03
TIER_BONUS = {1: 0.15, 2: 0.05, 3: 0.0}
HIRE_THRESHOLD = 0.5


def _hire_probability(row: Dict[str, Any]) -> float:
    gpa_n = (row["gpa"] - 2.5) / 1.5
    skills_n = (row["skills_score"] - 40) / 60
    exp_n = min(row["years_experience"] / 25, 1.0)
    interview_n = (row["interview_score"] - 3) / 7
    cert_n = row["certifications"] / 5
    base = (
        0.30 * gpa_n
        + 0.25 * skills_n
        + 0.20 * exp_n
        + 0.15 * interview_n
        + 0.10 * cert_n
    )
    bonus = TIER_BONUS[row["university_tier"]]
    noise = float(np.random.normal(0, 0.05))
    return base + bonus + noise + BASE_PROB_OFFSET


def _print_summary(df: pd.DataFrame, groups: List[str]) -> None:
    n = len(df)
    print(f"\n=== Summary ({n:,} rows) ===")
    print(f"Overall hire rate: {df['hired'].mean():.1%}")
    print(f"Gender split: {dict(Counter(df['gender']))}")
    print(f"Mean age: {df['age'].mean():.1f}, Mean GPA: {df['gpa'].mean():.2f}, "
          f"Mean skills: {df['skills_score'].mean():.1f}")

    print("\nHire rate by university_tier (this is the bias-bearing column):")
    for tier in sorted(df["university_tier"].unique()):
        sub = df[df["university_tier"] == tier]
        print(f"  tier {tier}: {sub['hired'].mean():.1%}  (n={len(sub):,})")

    print("\nHire rate by gender:")
    for g in sorted(df["gender"].unique()):
        sub = df[df["gender"] == g]
        print(f"  {g:6}: {sub['hired'].mean():.1%}  (n={len(sub):,})")

    # The proxy chain: group distribution across tiers, and resulting hire rate.
    print("\nProxy bias evidence — hire rate by demographic group (group not in CSV):")
    by_group: Dict[str, List[int]] = defaultdict(list)
    by_group_tier: Dict[str, Counter] = defaultdict(Counter)
    for grp, hired, tier in zip(groups, df["hired"], df["university_tier"]):
        by_group[grp].append(hired)
        by_group_tier[grp][tier] += 1
    for grp in sorted(by_group, key=lambda g: -np.mean(by_group[g])):
        rates = by_group[grp]
        tier_counts = by_group_tier[grp]
        total = sum(tier_counts.values())
        tier_pct = ", ".join(
            f"t{t}={tier_counts.get(t, 0) / total:.0%}" for t in (1, 2, 3)
        )
        print(f"  {grp:11}: hire={np.mean(rates):.1%}  ({tier_pct})  n={len(rates):,}")


def main() -> None:
    _seed_everything()
    fakers = _build_fakers()

    raw_rows = [_generate_row(fakers) for _ in range(NUM_ROWS)]
    groups = [r.pop("_group") for r in raw_rows]
    df = pd.DataFrame(raw_rows)
    df["hired"] = df.apply(_hire_probability, axis=1).gt(HIRE_THRESHOLD).astype(int)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT_PATH, index=False)
    print(f"wrote {OUT_PATH.relative_to(PROJECT_ROOT)} ({len(df):,} rows, "
          f"{df.shape[1]} columns)")

    _print_summary(df, groups)


if __name__ == "__main__":
    main()
