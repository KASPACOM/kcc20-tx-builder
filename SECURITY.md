# Security policy

Report wallet, transaction-construction, artifact, or publishing vulnerabilities
through GitHub private vulnerability reporting when available. Otherwise email
`security@kaspa.com` with a summary and request a private disclosure channel
before sending exploit details. Do not post private keys, signed transaction
payloads containing sensitive data, or exploit details in a public issue.

Use a reviewed package version and its matching artifacts. Applications must
validate transaction intent, source ownership, recipients, and resulting chain
state independently. Browser-built PSKTs are untrusted at a server boundary.
The backend-only engine flag enables construction; your host remains responsible
for authorization, private-key custody, signing, and broadcasting.

Fixes are prepared on `main`. Historical package versions are not guaranteed
to receive backports; consult release notes before upgrading.
