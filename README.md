# Eleagent

An elephant's memory. An agent's mind.

Eleagent records your day from a phone page — five-second video clips with sound and location — and turns it into a
memory you and your agents can ask about. It runs entirely on your own Vercel account: no servers or GPUs to run.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fokou-ai%2Feleagent&project-name=eleagent&repository-name=eleagent&env=OWNER_PASSWORD%2COPENROUTER_API_KEY%2CPYANNOTE_API_KEY&envDescription=Your%20sign-in%20password%2C%20an%20OpenRouter%20key%20and%20a%20pyannoteAI%20key&envLink=https%3A%2F%2Fgithub.com%2Fokou-ai%2Feleagent%23configuration&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

## What works today

- **Capture.** Open your deployment on a phone, sign in and recording starts. Clips wait in the browser until they are
  safely stored, so a dropped connection loses nothing. Clips go straight into a **private** Vercel Blob store; the
  server only signs each upload and records it in Postgres.

- **Agents.** Your agents read the memory over MCP at `https://<your deployment>/mcp`. Add that address in an agent
  that supports MCP (for example Okou); it sends you to your deployment to sign in and allow access. Access lasts until
  you disconnect the agent in `/account`. Today the tools list recordings and clips and hand out short-lived download
  links; more arrive as Eleagent learns to hear and see.

Next: hearing and seeing (who speaks with pyannoteAI, what was said and what happened around you with models on
OpenRouter) and nightly memory consolidation, each with MCP tools.

## Configuration

The Deploy button creates a private Blob store and a Neon Postgres database and asks for:

| Variable | What it is |
| --- | --- |
| `OWNER_PASSWORD` | The password you sign in with. Use a long one. |
| `OPENROUTER_API_KEY` | An [OpenRouter](https://openrouter.ai/keys) key. Requests require zero-data-retention providers. |
| `PYANNOTE_API_KEY` | A [pyannoteAI](https://dashboard.pyannote.ai) key, to recognise who is speaking. |

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
