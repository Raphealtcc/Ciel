# Cloudflare CIEL Worker export

This directory contains the complete deployed Worker export retrieved from Cloudflare on 2026-11-01.

The original multipart response was gzip-compressed and split into ordered Base64 text parts to avoid connector truncation. Reassemble it from the repository root:

```bash
cat ciel/cloudflare-export/index.js.gz.b64.part-* | base64 -d | gzip -dc > /tmp/ciel-worker-export.multipart
```

The multipart response contains the deployed `index.js` bundle. Extract it with Python:

```python
from email.parser import BytesParser
from email import policy
from pathlib import Path

raw = Path("/tmp/ciel-worker-export.multipart").read_bytes()
message = BytesParser(policy=policy.default).parsebytes(
    b"Content-Type: multipart/form-data; boundary=" + raw.split(b"\r\n", 1)[0][2:] + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw
)
for part in message.iter_parts():
    if part.get_param("name", header="content-disposition") == "index.js":
        Path("ciel/cloudflare-export/index.js").write_bytes(part.get_payload(decode=True))
        break
else:
    raise SystemExit("index.js not found in Cloudflare export")
```

The recovered file is the deployed, bundled JavaScript artifact. It is not a restoration of the original TypeScript source tree, package manifest, build scripts, or commit history.

No secret values were exported. Recreate secrets separately using protected/masked GitLab CI/CD variables or Cloudflare secrets.
