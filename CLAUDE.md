# CLAUDE.md — CounterProbe Project Instructions

## What This Project Is

CounterProbe is an adversarial fairness testing platform that red-teams AI models for
hidden bias using counterfactual probing.

## Architecture

- **Frontend:** Next.js 14 + Tailwind CSS + shadcn/ui → deployed to Firebase Hosting
- **Backend:** FastAPI (Python 3.11) → deployed to Google Cloud Run via Docker
- **AI:** Google Gemini 2.5 Flash via google-genai SDK (NOT Vertex AI, NOT OpenAI)
- **ML:** scikit-learn for model training, Fairlearn for 4/5ths rule computation
- **No database.** Everything is in-memory, stateless, session-only.

## Project Structure

```
counterprobe/
├── CLAUDE.md
├── README.md
├── .gitignore
├── frontend/              # Next.js app
│   ├── src/
│   │   ├── app/           # App router pages
│   │   ├── components/    # React components
│   │   └── lib/           # API client, types, utils
│   ├── public/
│   ├── next.config.js     # Must have output: 'export'
│   ├── tailwind.config.js
│   ├── package.json
│   └── firebase.json
├── backend/               # FastAPI app
│   ├── app/
│   │   ├── main.py        # FastAPI app entry, CORS, route registration
│   │   ├── routers/
│   │   │   ├── upload.py      # POST /api/upload
│   │   │   ├── baseline.py    # POST /api/configure-baseline
│   │   │   ├── probe.py       # POST /api/run-probes (SSE streaming)
│   │   │   ├── remediate.py   # POST /api/remediate, POST /api/rescan
│   │   │   └── health.py      # GET /api/health
│   │   ├── services/
│   │   │   ├── data_processor.py   # CSV parsing, column profiling
│   │   │   ├── model_trainer.py    # scikit-learn model training
│   │   │   ├── probe_engine.py     # Counterfactual probe generation + execution
│   │   │   ├── gemini_client.py    # ALL Gemini API interactions
│   │   │   ├── cve_grader.py       # CVE severity grading logic
│   │   │   └── remediator.py       # Fix application + re-probe logic
│   │   ├── models/
│   │   │   └── schemas.py          # Pydantic models for all request/response
│   │   └── utils/
│   │       ├── constants.py        # Thresholds, severity levels, config
│   │       └── session_store.py    # In-memory session storage for uploaded data
│   ├── demo_data/
│   │   └── hiring_data.csv         # Pre-generated synthetic dataset
│   ├── Dockerfile
│   ├── requirements.txt
│   └── .env.example
└── scripts/
    └── generate_dataset.py  # Script to create synthetic hiring dataset
```

## Critical Rules

1. **Gemini SDK:** Use `google-genai` package, NOT `google-generativeai` (old), NOT `vertexai`.
```python
   from google import genai
   client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
   response = client.models.generate_content(
       model="gemini-2.5-flash",
       contents="prompt here",
       config=genai.types.GenerateContentConfig(
           response_mime_type="application/json",
       )
   )
```

2. **No database.** Use an in-memory dictionary keyed by session ID to store
   uploaded DataFrames and trained models during a session.

3. **CORS:** Backend must allow the Firebase Hosting origin. During dev, allow localhost:3000.
```python
   app.add_middleware(
       CORSMiddleware,
       allow_origins=["http://localhost:3000", "https://YOUR-APP.web.app"],
       allow_methods=["*"],
       allow_headers=["*"],
   )
```

4. **SSE Streaming:** Use `sse-starlette` for the probe execution endpoint.
   Each probe result streams as a server-sent event so the frontend can
   update the progress counter in real time.

5. **Next.js Static Export:** The frontend MUST be statically exportable.
```js
   // next.config.js
   const nextConfig = { output: 'export', trailingSlash: true }
```
   No server-side rendering. No API routes in Next.js. All API calls go to
   the FastAPI backend.

6. **Environment Variables (Frontend):**
   Use NEXT_PUBLIC_API_URL for the backend URL.
   During dev: http://localhost:8000
   In production: your Cloud Run URL

7. **File descriptions:** Start every new file with a comment block explaining
   what the file does and its role in the system.

8. **Type safety:** Use Pydantic models for all FastAPI request/response schemas.
   Use TypeScript interfaces in the frontend matching the Pydantic models.

9. **Error handling:** Every endpoint must have try/except. Every Gemini call
   must handle timeouts and malformed responses. Frontend must show error
   states, not crash.

10. **No localStorage** in frontend artifacts. Use React state only.

## Key Concepts (so Claude Code understands the domain)

### Business Necessity Baseline
User splits dataset columns into two groups:
- Legitimate factors: columns that SHOULD affect the decision (skills, GPA, experience)
- Protected attributes: columns that should NOT affect the decision (name, gender, age)
Gemini also advises on this split, flagging proxy variables (e.g., university_tier proxies socioeconomic status).

### Counterfactual Probes
Take a real data row, create variants where ONLY protected attributes change, keep
legitimate factors identical. Fire both through the model. If the prediction changes,
that's an anomaly. Aggregate anomalies into bias patterns.

### CVE Vulnerability Report
Each bias pattern becomes a structured entry with:
- Severity: CRITICAL / HIGH / MEDIUM / LOW
- Evidence: probe counts, flip rates, 4/5ths rule ratio
- Root cause: which feature interaction drives the bias
- Remediation: specific fix with Python code

### Probe-Fix-Rescan
Apply the recommended fix → retrain model → re-run all probes → compare
before/after failure rates. Empirical proof the fix works.

## Design Direction for Frontend

Aesthetic: Clean, professional, slightly editorial. Think: security audit report meets
modern SaaS. Dark sidebar, light content area. Monospace font for data/metrics,
sans-serif for UI text. Red/amber/green severity colors must be prominent.

Key UI pages:
1. Landing / Upload page
2. Baseline Configuration (two-column drag or checkbox interface)
3. Probe Progress (progress bar + live counters via SSE)
4. CVE Report (severity-badged cards, expandable detail)
5. Remediation + Before/After comparison

Use shadcn/ui components: Card, Badge, Button, Dialog, Progress, Tabs, Separator.
Use Recharts for any charts (bar chart for before/after comparison).

## Testing Commands

```bash
# Backend
cd backend
python -m pytest tests/ -v
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
npm run dev    # development
npm run build  # test static export
npm run lint

# Docker (backend)
cd backend
docker build -t fairlens-api .
docker run -p 8000:8080 -e GEMINI_API_KEY=your_key fairlens-api
```

## Deployment Commands

```bash
# Backend → Cloud Run
cd backend
gcloud builds submit --tag gcr.io/PROJECT_ID/fairlens-api
gcloud run deploy fairlens-api \
  --image gcr.io/PROJECT_ID/fairlens-api \
  --platform managed \
  --allow-unauthenticated \
  --region us-central1 \
  --memory 2Gi \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest

# Frontend → Firebase Hosting
cd frontend
npm run build
firebase deploy --only hosting
```

## Testing Rule
I'm on Windows PowerShell. For all tests, never use curl or python -c.
Always create a Python test script(backend/tests), run it, and show the output.

## Frontend Design Rules (STRICT)

Use a dark theme as the primary aesthetic. Color palette:
- Background: #0A0A0B (near-black)
- Cards/surfaces: #141416 with subtle border (#1F1F23)
- Primary accent: #6366F1 (indigo) for buttons and active states
- Critical/Red: #EF4444
- High/Orange: #F97316  
- Medium/Yellow: #EAB308
- Low/Green: #22C55E
- Text primary: #F4F4F5
- Text secondary: #A1A1AA

Typography:
- Headings: font-family "Inter" or system sans-serif, font-weight 600
- Body: same family, font-weight 400
- Data/metrics/code: font-family "JetBrains Mono" or monospace

Component styling:
- All cards: rounded-xl with border border-white/5 and bg-[#141416]
- Severity badges: pill-shaped with colored backgrounds at 15% opacity
  and colored text (e.g., bg-red-500/15 text-red-400 for CRITICAL)
- Buttons: rounded-lg with indigo background, no harsh borders
- Progress bar: indigo fill on dark track, with subtle glow animation
- CVE cards: left border-4 colored by severity (red/orange/yellow/green)

Layout:
- No sidebar. Full-width single-column layout with max-w-5xl centered.
- Stepper at the top showing 4 steps with connecting lines.
- Generous padding (p-8) and spacing (space-y-6) between sections.
- The comparison table ("Without FairLens vs With FairLens") should be 
  a prominent two-column card with contrasting backgrounds.

Animations:
- Probe counter numbers should use tabular-nums font-variant for smooth 
  number transitions
- Cards should fade in with a subtle y-translate on mount
- The anomaly counter should pulse red briefly when it increments

DO NOT use default shadcn light theme. DO NOT use generic gray backgrounds.
Everything should feel like a security audit dashboard — dark, precise, data-heavy.
