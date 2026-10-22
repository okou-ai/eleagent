# Eleagent

An elephant's memory. An agent's mind.

Eleagent records your day from a phone page — five-second video clips with sound and location — and turns it into a
memory you and your agents can ask about. It runs entirely on your own Vercel account: no servers or GPUs to run.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fokou-ai%2Feleagent&project-name=eleagent&repository-name=eleagent&env=OWNER_PASSWORD%2COPENROUTER_API_KEY%2CPYANNOTE_API_KEY&envDescription=Your%20sign-in%20password%2C%20an%20OpenRouter%20key%20and%20a%20pyannoteAI%20key&envLink=https%3A%2F%2Fgithub.com%2Fokou-ai%2Feleagent%23configuration&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

## What works today

- **Capture.** Open your deployment on a phone, sign in and recording starts. Clips wait in the browser until they are
  safely stored, so a dropped connection loses nothing. Clips go straight into a **private** Vercel Blob store; the
  server only signs each upload and records it in Postgres.

- **Hearing and seeing.** Each minute of a recording is transcribed by speaker (ElevenLabs Scribe v2) and described
  from its stills and sound (Xiaomi MiMo), both through OpenRouter with zero-data-retention providers. A minute is
  processed once the recording has moved on, usually within a minute or two, for well under a cent per minute.
- **Sleep.** Each night (03:00 in Shanghai by default, see `vercel.json`) an agent turns the previous day into
  long-term memory: [Pi](https://github.com/earendil-works/pi), running in a [Vercel Sandbox](https://vercel.com/docs/sandbox)
  with Eleagent's memory tools. It reads the day's episodes, looks at stills where details matter, creates or enriches
  people, objects, places, routines and readings, saves the day's events and conversations (with their original words)
  and links them, and writes a first-person diary with time anchors back to the recorded minutes. It may only finish
  once every stretch of speech is remembered as a conversation or dismissed with a reason. The sandbox reaches nothing
  but this deployment: its firewall adds the run's token, and the deployment holds the OpenRouter key. `/account` can
  also sleep today so far. Days follow the time zone the phone reports (`TIMEZONE` overrides it).
- **Okou.** Connect [Okou](https://okou.ai) in `/account` and ask it for things out loud while recording ("Okou,
  find the brand of these eye drops"): after each minute is heard, a model decides whether the newest words were a
  request for Okou and, if so, hands Okou one message it can act on, with the time and place, in one standing Okou
  conversation. Speech from other people, calls or videos is not handed over; nothing is sent twice.
- **Agents.** Your agents read the memory over MCP at `https://<your deployment>/mcp`. Add that address in an agent
  that supports MCP (for example Okou); it sends you to your deployment to sign in and allow access. Access lasts until
  you disconnect the agent in `/account`. Today the tools list recordings and clips and hand out short-lived download
  links, stills from any moment, what was heard and seen in each minute (by time, or searched by words), and the
  long-term memories and diaries, with the same tools as the self-hosted Eleagent (`search_entities`, `get_entity`,
  `list_entity_links`, `get_subgraph`).

Next: recognising who speaks (pyannoteAI voiceprints), so that only the owner's own requests reach Okou.

## Configuration

The Deploy button creates a private Blob store and a Neon Postgres database and asks for:

| Variable | What it is |
| --- | --- |
| `OWNER_PASSWORD` | The password you sign in with. Use a long one. |
| `OPENROUTER_API_KEY` | An [OpenRouter](https://openrouter.ai/keys) key. Requests require zero-data-retention providers. |
| `PYANNOTE_API_KEY` | A [pyannoteAI](https://dashboard.pyannote.ai) key, to recognise who is speaking. |

Sleep starts from a Vercel Cron job; set `CRON_SECRET` so that only Vercel can start it (without it anyone can, but it
only ever starts a day that is due). `SLEEP_MODEL` picks the agent's OpenRouter model (default `z-ai/glm-5.3-flash`). Observations, memories and the diary are written in English; set
`MEMORY_LANGUAGE` (for example `Chinese`) to have them written in another language. Speech and visible text always stay
in their own language.

Sign-in and agent access use [Better Auth](https://www.better-auth.com): one owner, no sign-up. Its secret is generated
into the database on the first build; set `BETTER_AUTH_SECRET` to supply your own, and `BETTER_AUTH_URL` if the
deployment should answer agents on a custom domain rather than its production `vercel.app` address.

The database schema is applied on every production build (`scripts/migrate.mjs`). Preview deployments share the
production database unless Neon gives each one a branch, so they apply migrations only when `PREVIEW_DATABASE=branch`
is set for the Preview environment: turn on preview branching in the Neon integration first.

## Development

```sh
npm install
vercel env pull .env.local   # DATABASE_URL, Blob credentials and the keys above
npm run dev
npm test && npm run typecheck && npm run lint
```

## License

[AGPL-3.0](LICENSE)
