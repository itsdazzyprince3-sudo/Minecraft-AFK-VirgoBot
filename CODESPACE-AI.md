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

## 5. Keeping it awake (best effort)

GitHub resets the idle timer on **terminal input or output**, not on requests to
a forwarded port. The devcontainer starts a detached tmux session that prints a
tick every 45 seconds, which simulates terminal output:

```sh
scripts/codespace-keepalive.sh status   # check whether it is running
scripts/codespace-keepalive.sh stop     # disable it
scripts/codespace-keepalive.sh start    # enable it again
```

This is not an official GitHub feature. It usually prevents the idle stop, but
GitHub can change the detection at any time, and it does **not** bypass the
12-hour maximum lifetime or the monthly quota.

## 6. Starting it again later

Codespaces stop when idle or after 12 hours, so the AI URL stops working.
Restart with:

```sh
gh codespace start -c virgo-ai
```

The devcontainer's `postStartCommand` starts Ollama and the keep-alive session
automatically. The public port visibility may need to be set again after a
restart:

```sh
gh codespace ports visibility 11434:public -c virgo-ai
```

## Important limitations

- **Best-effort keep-alive.** The tmux tick is a workaround, not a guarantee.
  API traffic alone does not keep the Codespace alive.
- **12-hour maximum lifetime.** Regardless of the idle timeout, a Codespace has
  a maximum lifetime of 12 hours. It must be started again after that.
- **Free quota.** The free plan includes 120 core-hours per month. A 2-core
  Codespace therefore lasts at most about 60 hours of runtime per month
  (roughly 2.5 days if run continuously), so it cannot host AI 24/7.
- **Public means public.** Anyone with the URL can query the model and consume
  your quota. Treat the URL as a secret and delete the Codespace when done:
  `gh codespace delete -c virgo-ai`.
- **Model download is per Codespace.** Rebuilding or deleting the Codespace
  downloads the ~1 GB model again.
- **CPU only.** Free Codespaces have no GPU, so replies take seconds; the first
  request after the model unloads can take ~30–60 seconds.

## If you need always-on AI

The bot already supports cloud providers, and they work from any phone or
terminal without a Codespace:

- **Gemini:** set `AI_API_KEY` in `.env` and leave `ai.provider` as `"auto"`.
- **Any OpenAI-compatible API** (OpenRouter, Groq, etc.): set
  `AI_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_API_URL`, and `OPENAI_MODEL`
  in `.env`.

With a cloud key, local Ollama and the Codespace are not used at all, so nothing
sleeps and no quota is consumed beyond the API's own limits.
