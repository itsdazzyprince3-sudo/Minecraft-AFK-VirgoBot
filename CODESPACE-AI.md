# Run the bot's AI in GitHub Codespaces

This setup hosts **Ollama** in a GitHub Codespace and exposes its `/api/chat`
endpoint over HTTPS, so the bot itself can run on any machine or phone and only
the AI lives in the cloud.

The repository already contains:

- `.devcontainer/devcontainer.json` — installs and starts Ollama on port `11434`
- `scripts/codespace-ai.sh` — installs Ollama, pulls the model, prints the URL

The bot needs no code changes: `ai.provider: "auto"` already uses Ollama when no
cloud API key is set, and both `OLLAMA_URL` and `OLLAMA_MODEL` can be set in
`.env`.

---

## 1. Authorize the GitHub CLI once

The CLI needs the `codespace` scope (the current login only has `repo`,
`workflow`, `gist`, and `read:org`):

```sh
gh auth refresh -h github.com -s codespace
```

Follow the browser/device prompt. You only do this once.

## 2. Create the Codespace

From the repository folder:

```sh
gh codespace create \
  -R itsdazzyprince3-sudo/Minecraft-AFK-VirgoBot \
  -m basicLinux32gb \
  --idle-timeout 240m \
  -d virgo-ai
```

Creation takes several minutes: the devcontainer installs Ollama and downloads
`qwen2.5:1.5b` (~1 GB). Check progress with:

```sh
gh codespace list
gh codespace logs -c virgo-ai
```

You can also create it from the GitHub website: **Code → Codespaces → Create
codespace on main**. The devcontainer does the rest.

## 3. Make the AI port public

Codespaces ports are private by default, so requests from your phone would get a
GitHub login page. Make port `11434` public:

```sh
gh codespace ports visibility 11434:public -c virgo-ai
```

Then read the public URL:

```sh
gh codespace ports -c virgo-ai --json sourcePort,browseUrl
```

The URL looks like:

```text
https://virgo-ai-<random>-11434.app.github.dev
```

Test it from any device (no login required once public):

```sh
curl https://virgo-ai-<random>-11434.app.github.dev/api/tags
```

## 4. Point the bot at it

On the device that runs the bot (laptop, phone/Termux, another PC), add to
`.env` in the repository folder:

```sh
OLLAMA_URL=https://virgo-ai-<random>-11434.app.github.dev/api/chat
OLLAMA_MODEL=qwen2.5:1.5b
```

Keep `ai.provider` as `"auto"` and do **not** set `AI_API_KEY` if you want the
Codespace model to be used. Then restart:

```sh
npm start
```

The dashboard log should show the AI answering instead of falling back to canned
replies. You can also test the model directly:

```sh
curl https://virgo-ai-<random>-11434.app.github.dev/api/chat \
  -d '{"model":"qwen2.5:1.5b","stream":false,"messages":[{"role":"user","content":"hello"}]}'
```

## 5. Starting it again later

Codespaces stop when idle, so the AI URL stops working. Restart with:

```sh
gh codespace start -c virgo-ai
```

The devcontainer's `postStartCommand` starts Ollama automatically. The public
port visibility may need to be set again after a restart:

```sh
gh codespace ports visibility 11434:public -c virgo-ai
```

## Important limitations

- **Not 24/7.** Codespaces stop after the idle timeout (maximum 240 minutes).
  Traffic to the forwarded port does not count as activity. If the bot must have
  AI around the clock, use a small VPS or a cloud API key instead.
- **Free quota.** The free plan includes limited core-hours and storage per
  month. A 2-core Codespace uses roughly 2 core-hours per hour it runs.
- **Public means public.** Anyone with the URL can query the model and consume
  your quota. Treat the URL as a secret and delete the Codespace when done:
  `gh codespace delete -c virgo-ai`.
- **Model download is per Codespace.** Rebuilding or deleting the Codespace
  downloads the ~1 GB model again.
- **CPU only.** Free Codespaces have no GPU, so replies take seconds; the first
  request after the model unloads can take ~30–60 seconds.
