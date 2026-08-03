---
title: Hunter Analysis Examples
description: Calibration cases for evidence-backed Hunter findings.
prompt: |
  launch parallel agnents and finish it all

  Preserve the legacy Hunter calibration content and make
  @skills/hunter/SKILL.md the canonical runtime source.
---

# Hunter Analysis Examples

Role-skill calibration examples showing the expected analysis process and BUG-N output format with STRIDE/CWE classification. Study these before scanning.

---

## Example 1: SQL Injection — CONFIRMED (Critical)

**Input code** (`src/api/users.py:45-52`):
```python
def search_users(request):
    query = request.GET.get('q', '')
    sql = f"SELECT * FROM users WHERE name LIKE '%{query}%'"
    cursor.execute(sql)
    return cursor.fetchall()
```

**Analysis:** `query` from HTTP param → f-string interpolation → `cursor.execute()`. No sanitization, no ORM, no parameterization.

**Output:**
```
**BUG-1** | Severity: Critical | Points: 10
- **File:** src/api/users.py
- **Line(s):** 45-52
- **Category:** security
- **STRIDE:** Tampering
- **CWE:** CWE-89
- **Claim:** SQL injection via unsanitized user input in f-string query
- **Evidence:** `sql = f"SELECT * FROM users WHERE name LIKE '%{query}%'"` (line 47)
- **Runtime trigger:** GET /api/users?q=test' OR '1'='1 — returns all users instead of search results
- **Cross-references:** Single file
```

---

## Example 2: IDOR — CONFIRMED (Critical)

**Input code** (`src/routes/documents.js:23-30`):
```javascript
router.get('/api/documents/:id', async (req, res) => {
  const document = await Document.findById(req.params.id);
  if (!document) return res.status(404).json({ error: 'Not found' });
  res.json(document);
});
```

**Analysis:** `req.params.id` → `findById()` → response. No ownership check. Any user can access any document by ID.

**Output:**
```
**BUG-2** | Severity: Critical | Points: 10
- **File:** src/routes/documents.js
- **Line(s):** 23-30
- **Category:** security
- **STRIDE:** InfoDisclosure
- **CWE:** CWE-639
- **Claim:** IDOR — document access without ownership verification
- **Evidence:** `const document = await Document.findById(req.params.id);` (line 24) — no user/ownership filter
- **Runtime trigger:** GET /api/documents/other-users-doc-id — returns another user's private document
- **Cross-references:** Single file
```

---

## Example 3: Command Injection — CONFIRMED (Critical)

**Input code** (`src/utils/image_processor.py:15-20`):
```python
def resize_image(filename, width, height):
    command = f"convert {filename} -resize {width}x{height} resized_{filename}"
    os.system(command)
```

**Analysis:** `filename` → f-string → `os.system()`. Shell metacharacters in filename = RCE.

**Output:**
```
**BUG-3** | Severity: Critical | Points: 10
- **File:** src/utils/image_processor.py
- **Line(s):** 15-20
- **Category:** security
- **STRIDE:** Tampering
- **CWE:** CWE-78
- **Claim:** Command injection via unsanitized filename in os.system()
- **Evidence:** `os.system(f"convert {filename} -resize {width}x{height} resized_{filename}")` (line 17)
- **Runtime trigger:** Upload file named `img.jpg; rm -rf / #` — executes arbitrary shell commands
- **Cross-references:** Single file
```

---

## Example 4: FALSE POSITIVE — Parameterized Query

**Input code** (`src/api/products.py:30-35`):
```python
def get_products(category_id):
    cursor.execute("SELECT * FROM products WHERE category_id = %s", (category_id,))
    return cursor.fetchall()
```

**Analysis:** Uses `%s` placeholder with parameter tuple — this is parameterized, NOT string formatting. The database driver handles escaping. This is the SAFE pattern.

**Result: NO FINDING.** Do not report this.

---

## Example 5: FALSE POSITIVE — Authorization in Middleware

**Input code** (`src/routes/documents.ts:15-22`):
```typescript
router.get('/api/documents/:id',
  requireAuth,
  requireOwnership('document'),
  async (req, res) => {
    const document = await Document.findById(req.params.id);
    res.json(document);
  }
);
```

**Analysis:** The handler doesn't check ownership, BUT `requireOwnership('document')` middleware runs first. Authorization is enforced in a different layer — this is a valid and common pattern.

**Result: NO FINDING.** Do not report this.

---

## Key Calibration Points

**Report when:** Direct user input → dangerous sink with no validation/sanitization in the path.

**Do NOT report when:** Input is parameterized, validated by middleware/schema, or comes from a trusted source (JWT, server-signed token). Always trace the FULL data flow before reporting.
