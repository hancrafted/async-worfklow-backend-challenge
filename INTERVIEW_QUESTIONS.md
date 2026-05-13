# osapiens John Doe — Mock Interview Questions

---

## Frontmatter

```yaml
interview_role: John Doe — Head of Business Partner Transparency, osapiens
interviewer_profile: |
  15+ years enterprise software (IBM → HCL → osapiens). Started in the code,
  moved to engineering management and architecture. Certified LeSS Practitioner.
  Gave talk at APIWorld 2024: "How to Build a High Performance Engineering Team."
  Builder at heart. Values depth over breadth, direct communication,
  and transparency — literally his product line. Based in Madrid, German-speaking.
  Will probe architecture decisions, leadership, agile transformation, cultural fit.

job_role: Full Stack Team Lead — TypeScript product teams (Business Partner + Product Transparency)
job_key_focus: |
  Full-stack product/feature focus. Must own the coding challenge cold.
  Raise the bar on frontend quality. Introduce modern agile practices.
  Cross-functional team leadership. Compliance domain awareness.

candidate_profile: |
  Han Che — Staff Software Engineer. Full-stack TypeScript (Node.js/React).
  Led 10 junior developers at Audi. Built multi-tenant SaaS MES used across
  5 European factories. Backend challenge: async workflow engine with per-worker
  DataSources, WAL mode, state machine, no lease/heartbeat. Frontend challenge:
  React with MobX, MUI, complex state management. Engineering-minded, direct,
  asks questions before building.

interview_mode: |
  John conducts. High-level technical probing, not nitpicking. Follows up on
  weak points. Pushes back when answers are vague. Checks cultural fit through
  questions about past experience, motivation, and how candidate handles
  ambiguity. Asks for help → provide question intent + help formulate answer.
```

---

## How to Run This Mock Interview

- Conduct 2–3 rounds of practice (each round = full interview simulation)
- Between rounds, ask for feedback — I'll give honest assessment
- When you ask "help me with this question," I'll give:
  1. **What John is really asking** (the intent behind the question)
  2. **How to frame your answer** (structure + key points)
  3. **What John will push back on** (likely weak points in a typical answer)

---

## Question 1 — "Walk me through the architecture of your backend challenge."

**What it tests:** Whether you actually own the code or just implemented it.

**Follow-up vectors:**
- "You said the worker pool uses per-worker DataSources. Why per-worker and not a shared connection?"
- "Your result schema splits Result from Task. Walk me through the reasoning — why separate tables?"
- "The README says no lease, no heartbeat. What guarantees do you have that a worker doesn't pick up the same task twice?"

**If vague → push:** "That's a description, not an architecture. Can you whiteboard it for me in 90 seconds?"

---

## Question 2 — "At scale, what would you change about your backend design?"

**What it tests:** Second-order thinking. Whether you know the production-grade alternative to your challenge choices.

**Follow-up vectors:**
- "You migrated from SQLite to Postgres — walk me through that decision. What broke at the SQLite level that made you switch?"
- "Postgres at high throughput: what's your escape hatch? When do you reach for Kafka instead?"
- "Your claim transaction — how long does it hold the lock? What happens if the worker crashes mid-transaction?"

**If hand-wavy → push:** "You've thought about this theoretically, but what specifically would fail at 10x your test load?"

---

## Question 3 — "Tell me about a time you raised the bar on a team you led."

**What it tests:** Leadership style. Whether you can own a team, not just contribute to one.

**Follow-up vectors:**
- "You said code quality improved. What specifically did you change, and how did you get the team to adopt it?"
- "What did you do when a senior developer pushed back on your standards?"
- "How did you measure whether the bar was actually higher — what metrics or signals did you track?"

**If generic → push:** "That's a textbook answer. What was the messy part? Where did it get hard?"

---

## Question 4 — "Describe a time you had to deliver something under conflicting requirements."

**What it tests:** Requirements engineering. How you navigate ambiguity when product, legal, and engineering pull in different directions.

**Follow-up vectors:**
- "Who owned the final call on the trade-off? Was it you, or did you escalate?"
- "What would you have done differently if you had another week?"
- "How did you communicate the compromise to the team and to stakeholders?"

**If surface-level → push:** "Product wanted feature X, engineering said it would take 3 months, legal flagged compliance risk — what actually happened in that room?"

---

## Question 5 — "How do you handle a situation where a feature is technically sound but the domain is unclear?"

**What it tests:** Product thinking. Whether you can operate without a complete spec, and how you close the domain gap.

**Follow-up vectors:**
- "When you discovered the domain was unclear, what did you do — ask product, read code, talk to the customer?"
- "Can you give an example of a time the domain ambiguity caused a technical direction change mid-sprint?"
- "How do you prevent unclear requirements from becoming technical debt?"

**If you say "I just built what was asked" → push:** "That works until it doesn't. Walk me through how you'd catch a domain gap before writing code."

---

## Question 6 — "You've worked in regulated environments — manufacturing, automotive. What did that teach you about building compliance software?"

**What it tests:** Domain adaptability. Whether you can transfer patterns from regulated industries to osapiens' ESG compliance space.

**Follow-up vectors:**
- "What's the difference between compliance in manufacturing and compliance in supply chain transparency — from a software perspective?"
- "MES systems handle audit trails. How does that compare to what osapiens needs for EUDR or LkSG?"
- "What surprised you about working in a regulated domain that you didn't expect?"

**If you haven't thought this through → push:** "You have the MES experience but not the ESG experience. How do you convince me you'd learn the domain fast enough?"

---

## Question 7 — "What do you know about osapiens — and why this role?"

**What it tests:** Research quality. Whether you came prepared with specific knowledge or generic answers.

**Follow-up vectors:**
- "You said osapiens does supply chain transparency. What's the hardest compliance problem their customers face that software actually solves?"
- "The Business Partner Transparency unit — what do you think John's team actually does day-to-day?"
- "If you joined and got it wrong about osapiens, what would that mistake look like in 6 months?"

**If vague → push:** "You said 'supply chain compliance.' That's three words. Can you be specific about one regulation and one customer problem osapiens solves?"

---

## Question 8 — "Describe an engineering culture you've been part of that worked well. What made it work?"

**What it tests:** Cultural fit. Whether you thrive in osapiens' fast-moving SaaS scale-up or if you'd gravitate toward more structure.

**Follow-up vectors:**
- "You mentioned autonomy. What does that mean to you in practice — does it mean no code review? Or something else?"
- "What would you change about your last team's culture if you could?"
- "How do you handle it when the pace is high and the process is low?"

**If you describe a slow, process-heavy culture as ideal → push:** "osapiens is 500 people, growing fast, with 25–30 products. That's not slow and process-heavy. Walk me through why you'd thrive there rather than just survive."

---

## Question 9 — "Tell me about a time you had to have a hard conversation with a direct report."

**What it tests:** Leadership maturity. Whether you've actually managed people through difficulty, not just around them.

**Follow-up vectors:**
- "How did you prepare for that conversation? Did you have data, or was it gut feel?"
- "What happened after — did performance improve, or did you end up managing them out?"
- "What would you do differently if you had that conversation again?"

**If you give a polished ending → push:** "You're giving me the highlight reel. What was the ugly part — the part you didn't enjoy?"

---

## Question 10 — "You're leading a team and two engineers disagree on a shared component's design. Both are senior. How do you resolve it?"

**What it tests:** Technical conflict resolution. How you handle architecture decisions when you have smart people on both sides.

**Follow-up vectors:**
- "Do you make the call yourself, or do you facilitate? What's the difference in your mind?"
- "What if one of them is more senior than you in this specific domain?"
- "How do you prevent this from becoming a recurring issue with the same people?"

**If you say "I chose the better technical solution" → push:** "What makes a solution 'better' in that context — and who decides?"

---

## Question 11 — "What's your approach to onboarding a new team member?"

**What it tests:** Team stewardship. Whether you've thought about how knowledge transfer actually works, not just the paperwork.

**Follow-up vectors:**
- "You have 5–8 developers on a team. How do you keep code quality consistent as the team grows?"
- "What do you do when someone joins who knows more than you do about their area?"
- "How do you balance getting them productive fast vs. letting them find their own way?"

---

## Question 12 — "Where do you see yourself in 3 years — and does osapiens fit that?"

**What it tests:** Self-awareness and commitment. Whether you have a real direction or just want "a job."

**Follow-up vectors:**
- "You said you want to grow as a technical leader. What does that mean specifically — more scope, bigger team, deeper architecture?"
- "What would make you leave osapiens in 18 months?"
- "If this role is a step down in title from what you have now, how do you frame that to yourself?"

---

## When You Need Help

To get question-level help, just say:
> **"Help me with Question [N]"**

And I'll respond with:
1. **What John is really testing** — the intent behind the question
2. **How to structure your answer** — the key points to hit
3. **Where John will likely push back** — the weak spots in a typical answer
4. **A strong answer example** — the level of depth and specificity John respects

---

## Round Structure Reference

| Phase | Time | What John does |
|-------|------|---------------|
| Warm-up | 5 min | Rapport + "tell me about yourself" |
| Technical | 20 min | Q1–Q2 (coding challenge architecture + scale) |
| Leadership | 15 min | Q3, Q9, Q10, Q11 (team leadership + conflict) |
| Requirements | 10 min | Q4, Q5 (requirements engineering + domain ambiguity) |
| Culture + Fit | 10 min | Q6, Q7, Q8 (domain, osapiens knowledge, culture) |
| Motivation | 5 min | Q12 (direction + commitment) |
| Your questions | 5 min | You ask John about the role, team, challenges |

---

*Good luck. John is direct and values clarity. No fluff, own what you know, admit what you don't.*
