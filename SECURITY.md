# Security Policy

The CilamAI team takes the security and privacy of our users seriously. We appreciate your efforts to responsibly disclose any vulnerabilities you find.

---

## Supported Versions

We provide security updates and patches for the following versions of CilamAI:

| Version | Supported          |
| :------ | :----------------- |
| `0.1.x` | :white_check_mark: |
| `< 0.1` | :x:                |

---

## Reporting a Vulnerability

If you discover a potential security vulnerability in CilamAI, please report it responsibly:

1. **Do not create a public GitHub issue** for undisclosed security vulnerabilities.
2. Send an email detailing the vulnerability to **security@cilamai.com** (or contact the maintainers via GitHub private vulnerability reporting).
3. Include the following details in your report:
   - Type of vulnerability (e.g., Remote Code Execution, Privilege Escalation, Context Bridge Bypass, Token Leakage).
   - Step-by-step instructions or Proof of Concept (PoC) to reproduce the issue.
   - Operating system and version of CilamAI affected.
   - Any suggested mitigations or patches.

---

## Security Architecture & Best Practices

CilamAI implements multiple layers of security to safeguard user data:

- **Context Isolation & Node Integration**:
  - `contextIsolation` is enabled by default across all web views and renderer windows.
  - `nodeIntegration` is disabled in the renderer to prevent arbitrary system access from web content.
- **Secure Preload Bridge**:
  - Only explicitly sanitized APIs and IPC channels are exposed via `contextBridge.exposeInMainWorld`.
- **Model Context Protocol (MCP) Sandbox**:
  - Local tool processes executed via `stdio` are strictly managed and restricted.
- **Credential Storage**:
  - API keys, OAuth tokens, and sensitive configurations are stored securely and never transmitted to unauthorized third parties.

---

## Disclosure Policy

- We will acknowledge receipt of your vulnerability report within **48 hours**.
- We will provide an initial assessment and timeline for a fix.
- Once a fix is verified and released, credit will be awarded to the reporter (unless you prefer to remain anonymous).
