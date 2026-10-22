#!/bin/bash
# One night of sleep inside the sandbox: run Pi with Eleagent's tools, then report how it ended.
cd /tmp/sleep
./node_modules/.bin/pi --print --mode json --no-session --no-skills --no-context-files --no-mcp --no-extensions \
  -e /tmp/sleep/extension.ts --tools "$SLEEP_TOOLS" --provider eleagent --model "$SLEEP_MODEL" --thinking "$SLEEP_THINKING" \
  --system-prompt "$(cat /tmp/sleep/sleep.md)" "$SLEEP_MESSAGE" > /tmp/sleep/events.jsonl 2> /tmp/sleep/stderr.txt
code=$?
{
  echo "exit $code"
  echo "events: $(grep -o '"type":"[a-z_]*"' /tmp/sleep/events.jsonl | sort | uniq -c | tr -s ' ' | tr '\n' ',')"
  tail -c 3000 /tmp/sleep/stderr.txt
} > /tmp/sleep/report.txt
curl -s -m 30 -X POST "$ELEAGENT_URL/api/sleep/report" -H 'Content-Type: text/plain' --data-binary @/tmp/sleep/report.txt > /dev/null
