---
title: Skeptic Validation Examples
description: Calibration cases for adversarial finding review.
prompt: |
  launch parallel agnents and finish it all

  Preserve the legacy Skeptic calibration content and make
  @skills/skeptic/SKILL.md the canonical runtime source.
---

# Skeptic Validation Examples

Role-skill calibration examples showing how to challenge Hunter findings. Study the reasoning process — the Skeptic's job is to kill false positives, not confirm real bugs.

---

## Example 1: ACCEPT — Real SQL Injection

**Hunter finding:** BUG-1, Critical, `src/api/users.py:47` — SQL injection via f-string.

**Skeptic process:**
1. Read `src/api/users.py:45-52` — confirmed f-string interpolation in SQL
2. Searched for validation middleware on the route — none found
3. Checked if ORM is used elsewhere — yes, but NOT in this function
4. Looked for input sanitization — none before `search_users()` is called

**Verdict:** `ACCEPT` — No mitigation found. The f-string directly interpolates user input into SQL. Cannot disprove.

---

## Example 2: ACCEPT — Real XSS via dangerouslySetInnerHTML

**Hunter finding:** BUG-5, Medium, `src/components/UserProfile.jsx:18` — stored XSS.

**Skeptic process:**
1. Read the component — confirmed `dangerouslySetInnerHTML={{ __html: user.bio }}`
2. Searched for DOMPurify or sanitize-html imports — not found in this file or its imports
3. Checked API route that saves bio — no server-side HTML sanitization
4. React auto-escaping is explicitly BYPASSED by dangerouslySetInnerHTML

**Verdict:** `ACCEPT` — dangerouslySetInnerHTML with unsanitized user content. React's XSS protection is deliberately bypassed.

---

## Example 3: DISPROVE — SQL Injection Behind Joi Validation

**Hunter finding:** BUG-7, High, `src/api/products.js:78` — SQL injection.

**Skeptic process:**
1. Read `src/api/products.js:78-82` — confirmed string interpolation in SQL
2. Traced the route: `routes/products.js:15` → `validateRequest(categorySchema)` middleware runs FIRST
3. Read `middleware/validation.js:23` — found `Joi.string().valid('electronics', 'clothing', 'food', 'other')`
4. Joi schema restricts input to 4 predefined enum values — SQL injection payload cannot pass validation
5. Request returns 400 before reaching the vulnerable code

**Verdict:** `DISPROVE` — Input validated by Joi schema at `middleware/validation.js:23`. Only 4 enum values are accepted; SQL injection payloads are rejected with 400 status before reaching this code.

---

## Example 4: DISPROVE — "IDOR" on JWT-Sourced userId

**Hunter finding:** BUG-9, High, `src/repositories/orderRepository.js:23` — IDOR on userId.

**Skeptic process:**
1. Read the repository code — `userId` is interpolated into SQL
2. Traced caller: `controllers/orderController.js:15` → `userId = req.user.id`
3. `req.user` is populated by JWT middleware at `middleware/auth.js:15`
4. JWT is cryptographically signed by server — user cannot modify their own `id`
5. The `userId` value is NOT user-controlled input — it's from a server-signed token

**Verdict:** `DISPROVE` — `userId` extracted from server-signed JWT (`req.user.id`), not from user-controlled input. User cannot forge or modify their JWT ID without the signing secret. Not exploitable as IDOR.

---

## Example 5: MANUAL REVIEW — Command Injection via Message Queue

**Hunter finding:** BUG-11, High, `src/workers/imageProcessor.js:56` — command injection.

**Skeptic process:**
1. Read `src/workers/imageProcessor.js:56-60` — confirmed `exec()` with string interpolation
2. Code is in a background worker, NOT directly callable from HTTP
3. Worker consumes messages from `image-processing` queue
4. Message contains `{ inputPath, size, outputPath }`
5. **Cannot trace** where these values originate — the publisher is in a different service
6. If `inputPath` includes user-provided filename → exploitable. If server-generated UUID → safe.

**Verdict:** `ACCEPT (LOW CONFIDENCE)` — The `exec()` call is dangerous, but data flow crosses service boundaries via message queue. Cannot fully verify if `inputPath` is user-controlled or server-generated. Flag for manual review.

---

## Key Calibration Points

**DISPROVE when:** You find specific code that prevents exploitation (validation middleware, parameterized queries, framework protection, trusted input source). Always cite the exact file + line.

**ACCEPT when:** You cannot find any mitigation after reading the actual code. Don't speculate about mitigations that might exist — if you can't find the code, accept the finding.

**LOW CONFIDENCE when:** Data flow crosses service boundaries, goes through message queues, or involves complex multi-step chains you can't fully trace.
