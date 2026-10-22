# Eleagent

An elephant's memory. An agent's mind.

Eleagent records your day from a phone page — five-second video clips with sound and location — and turns it into a
memory you and your agents can ask about. It runs entirely on your own Vercel account: no servers or GPUs to run.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fokou-ai%2Feleagent&project-name=eleagent&repository-name=eleagent&env=OWNER_PASSWORD%2COPENROUTER_API_KEY%2CPYANNOTE_API_KEY&envDescription=Your%20sign-in%20password%2C%20an%20OpenRouter%20key%20and%20a%20pyannoteAI%20key&envLink=https%3A%2F%2Fgithub.com%2Fokou-ai%2Feleagent%23configuration&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

## What works today

- **Capture.** Open your deployment on a phone, sign in and recording starts. Clips wait in the browser until they are
  safely stored, so a dropped connection loses nothing. Clips go straight into a **private** Vercel Blob store; the
  server only signs each upload and records it in Postgres.

Next: hearing and seeing (who speaks with pyannoteAI, what was said and what happened around you with models on
OpenRouter), nightly memory consolidation, and an MCP server so your agents can use the memory.

## Configuration

The Deploy button creates a private Blob store and a Neon Postgres database and asks for:

| Variable | What it is |
| --- | --- |
| `OWNER_PASSWORD` | The password you sign in with. Use a long one. |
| `OPENROUTER_API_KEY` | An [OpenRouter](https://openrouter.ai/keys) key. Requests require zero-data-retention providers. |
| `PYANNOTE_API_KEY` | A [pyannoteAI](https://dashboard.pyannote.ai) key, to recognise who is speaking. |

The database schema is applied on every build (`scripts/migrate.mjs`).

## Development

```sh
npm install
vercel env pull .env.local   # DATABASE_URL, Blob credentials and the keys above
npm run dev
npm test && npm run typecheck && npm run lint
```

## License

[AGPL-3.0](LICENSE)
