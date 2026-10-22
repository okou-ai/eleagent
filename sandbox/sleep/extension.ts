/**
 * Eleagent's sleep tools for Pi. Runs inside a Vercel Sandbox whose firewall only lets it reach the Eleagent
 * deployment (ELEAGENT_URL) and adds this run's token to every request there; the tools themselves are implemented by
 * the deployment (lib/sleep-tools.ts), which reads and writes the memory.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function call(name: string, params: unknown) {
	let body: { text?: string; images?: { data: string; mimeType: string }[] } = {};
	try {
		const response = await fetch(`${process.env.ELEAGENT_URL}/api/sleep/tools`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tool: name, args: params ?? {} }),
			signal: AbortSignal.timeout(240_000),
		});
		body = await response.json().catch(() => ({ text: `Error: HTTP ${response.status}` }));
	} catch (error) {
		body = { text: `Error: ${(error as Error).message}` };
	}
	const content: Content[] = [{ type: "text", text: body.text ?? "" }];
	for (const image of body.images ?? []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
	return { content, details: undefined };
}

const Ids = Type.Array(Type.String(), { description: "Memory ids such as person:owner or object:…" });
const Time = (description: string) => Type.String({ description: `${description}, local time HH:MM` });

const tools = [
	defineTool({
		name: "recall_day", label: "Recall day",
		description: "Start here: the day's episodes, its conversation candidates and their state, the day's diary and saved events and conversations so far, and the long-term memories.",
		parameters: Type.Object({}),
		execute: (_id, p) => call("recall_day", p),
	}),
	defineTool({
		name: "view_episode", label: "View episode",
		description: "Every recorded minute of one episode: what another model saw and heard (place, activity, people, objects, visible text, sounds) and the transcribed speech with times.",
		parameters: Type.Object({ id: Type.String({ description: "episode:… from recall_day" }) }),
		execute: (_id, p) => call("view_episode", p),
	}),
	defineTool({
		name: "view_moments", label: "View moments",
		description: "Still images of what the camera saw at up to six local times (HH:MM:SS or HH:MM). Use them to settle visual details: what something is, its label or brand, who or what was there, where it was.",
		parameters: Type.Object({ times: Type.Array(Type.String(), { maxItems: 6 }), size: Type.Optional(Type.Number({ description: "Longer side in pixels, default 640" })) }),
		execute: (_id, p) => call("view_moments", p),
	}),
	defineTool({
		name: "view_memory", label: "View memory",
		description: "Existing memories with all their properties (description, evidence, times, a conversation's transcript, a diary's text) and their links.",
		parameters: Type.Object({ ids: Ids }),
		execute: (_id, p) => call("view_memory", p),
	}),
	defineTool({
		name: "search_memory", label: "Search memory",
		description: "Find long-term memories whose name or text contains the words, optionally of one kind.",
		parameters: Type.Object({ query: Type.String(), kind: Type.Optional(Type.String()) }),
		execute: (_id, p) => call("search_memory", p),
	}),
	defineTool({
		name: "consolidate", label: "Consolidate",
		description: "Create or enrich a person, object, place, routine or reading memory. Give id to enrich an existing one (its description is replaced by yours, so integrate what it said); omit id to create one. merge folds other memories of the same kind into it (their links and evidence move over; they are removed).",
		parameters: Type.Object({
			id: Type.Optional(Type.String()), kind: Type.String({ description: "person | object | place | routine | reading" }),
			name: Type.String(), description: Type.String(),
			evidence: Type.Optional(Type.Array(Type.Object({ time: Type.String(), text: Type.String() }))),
			merge: Type.Optional(Ids),
		}),
		execute: (_id, p) => call("consolidate", p),
	}),
	defineTool({
		name: "remember_event", label: "Remember event",
		description: "Save something that happened today with its local start and end, linked to the memories involved.",
		parameters: Type.Object({ title: Type.String(), description: Type.String(), start: Time("Start"), end: Type.Optional(Time("End")), related: Type.Optional(Ids) }),
		execute: (_id, p) => call("remember_event", p),
	}),
	defineTool({
		name: "remember_conversation", label: "Remember conversation",
		description: "Save a conversation candidate as a conversation: its original transcript and times are kept with your title and summary, linked to the participants' memories.",
		parameters: Type.Object({ talk: Type.String({ description: "talk:… from recall_day" }), title: Type.String(), summary: Type.String(), participants: Type.Optional(Ids) }),
		execute: (_id, p) => call("remember_conversation", p),
	}),
	defineTool({
		name: "dismiss_conversation", label: "Dismiss conversation",
		description: "Mark a conversation candidate as not worth keeping, with the reason (a video or broadcast playing, background chatter, noise, the owner thinking aloud about nothing).",
		parameters: Type.Object({ talk: Type.String(), reason: Type.String() }),
		execute: (_id, p) => call("dismiss_conversation", p),
	}),
	defineTool({
		name: "link", label: "Link",
		description: "One plain sentence relating two memories, with the date when it concerns a particular day. Text is appended; rewrite replaces the link, and an empty rewrite removes it.",
		parameters: Type.Object({ a: Type.String(), b: Type.String(), text: Type.String(), rewrite: Type.Optional(Type.Boolean()) }),
		execute: (_id, p) => call("link", p),
	}),
	defineTool({
		name: "revise", label: "Revise",
		description: "Change a memory's name or description.",
		parameters: Type.Object({ id: Type.String(), name: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }),
		execute: (_id, p) => call("revise", p),
	}),
	defineTool({
		name: "forget", label: "Forget",
		description: "Remove memories that are wrong or not worth keeping. person:owner, conversations and diaries cannot be forgotten. Recordings are never deleted.",
		parameters: Type.Object({ ids: Ids }),
		execute: (_id, p) => call("forget", p),
	}),
	defineTool({
		name: "write_diary", label: "Write diary",
		description: "Replace the day's diary with one coherent first-person account of the recorded day, with ⟦HH:MM⟧ time anchors at notable moments; refs are the memories and conversations it mentions. Reports anchors that match no recorded minute.",
		parameters: Type.Object({ title: Type.String(), text: Type.String(), refs: Type.Optional(Ids) }),
		execute: (_id, p) => call("write_diary", p),
	}),
	defineTool({
		name: "finish", label: "Finish",
		description: "End the night. Refused while a conversation candidate is neither remembered nor dismissed, or the diary was not written in this run.",
		parameters: Type.Object({}),
		execute: (_id, p) => call("finish", p),
	}),
];

export default function eleagentSleepTools(pi: ExtensionAPI) {
	for (const tool of tools) pi.registerTool(tool);
}
