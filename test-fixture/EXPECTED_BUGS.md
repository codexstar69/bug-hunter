# Expected Bugs in Test Fixture

This file documents the intentionally planted bugs for pipeline validation.
Do NOT include this file in the scan (it's .md, auto-filtered).

## BUG 1: SQL Injection (Critical)
- **File:** auth.js:12
- **Issue:** User email concatenated directly into SQL query string
- **Trigger:** POST /auth/login with email: `' OR 1=1 --`

## BUG 2: Hardcoded JWT Secret (Critical)
- **File:** auth.js:18, auth.js:30
- **Issue:** JWT signed/verified with hardcoded string 'super-secret-key-123'
- **Trigger:** Anyone who reads the source code can forge tokens

## BUG 3: Broken Admin Authorization (Medium)
- **File:** auth.js:38
- **Issue:** `req.user.role == true` uses loose equality — any truthy role value passes
- **Trigger:** Any authenticated user with role="user" (truthy string) gets admin access

## BUG 4: Off-by-One Pagination (Medium)
- **File:** users.js:11
- **Issue:** `offset = page * limit` skips first page of results; should be `(page - 1) * limit`
- **Trigger:** GET /users?page=1 returns results starting from offset 20 instead of 0

## BUG 5: Silent Error Swallowing (Low)
- **File:** users.js:22-24
- **Issue:** Delete endpoint catches and ignores all errors, always returns success
- **Trigger:** DELETE /users/nonexistent returns 200 {success: true} even if query fails

## BUG 6: bcrypt.compare with non-string input (Medium)
- **File:** users.js:40-46
- **Issue:** req.body.password passed directly to bcrypt.compare without type check. JSON body can contain numbers, booleans, objects. bcrypt.compare throws on non-string/Buffer input.
- **Trigger:** POST /users/check-password with body {"password": 12345} — bcrypt.compare throws TypeError
- **Context7 test:** Hunter/Skeptic should verify bcrypt.compare behavior against actual bcrypt docs
