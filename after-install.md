## Keet Platform — Next Steps

✅ Plugin installed successfully.

### 1. Enable the plugin

```bash
hermes plugins enable keet-platform
```

### 2. Restart the gateway

```bash
hermes gateway restart
```

The bridge daemon will auto-start and connect to the Keet P2P network.

### 3. (Optional) Restrict access

```bash
# Allow only specific contacts (by public key)
hermes config set env_KEET_ALLOWED_USERS "pubkey1,pubkey2"
```

### 4. Find your bridge identity

Check the gateway logs for the bridge public key:

```bash
hermes log -n 20 | grep "Bridge identity"
```

Share this public key with contacts who want to message this agent.

---

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Bridge fails to start | Run `bash scripts/setup.sh` for guided setup |
| Node.js not found | Install Node.js >= 18: https://nodejs.org/en/download/ |
