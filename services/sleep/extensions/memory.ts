/**
 * Sleep-agent memory tools for pi. State lives in lib/memory.mjs (one instance per night, RUN_DIR).
 */
import { readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore plain ESM module
import { Memory } from "../lib/memory.mjs";

let memory: any;
const mem = () => (memory ??= new Memory(process.env.RUN_DIR));

async function call(name: string, params: unknown) {
	const res = await mem()[name](params ?? {});
	const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: res.text ?? "" }];
	for (const file of res.images ?? []) content.push({ type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/jpeg" });
	return { content, details: undefined };
}

const Ids = Type.Array(Type.String(), { description: "Candidate ids (obj-…, face-…, voice-…) and/or node ids (episode:…, speech:…, or memory entity ids)" });

const tools = [
	defineTool({
		name: "recall_day",
		label: "Recall day",
		description: "Start here: the day's new fragments (episodes, conversations, candidates, readings) if any, its earlier diary, conversations, entities and links, possible duplicates and all long-term memories.",
		parameters: Type.Object({}),
		execute: (_id, p) => call("recall_day", p),
	}),
	defineTool({
		name: "view_episode",
		label: "View episode",
		description: "Returns text for one physical capture episode: timestamped upstream MiniCPM/speech observations, readings, transcript and candidate IDs. It does not return images; visual descriptions are another model's reports. Returned archive_window_id values identify inspected evidence for remember_event; the episode ID identifies the capture bucket. Without archive access, remaining observation strings have no precise timestamps.",
		parameters: Type.Object({ id: Type.String({ description: "episode:… id" }) }),
		execute: (_id, p) => call("view_episode", p),
	}),
	defineTool({
		name: "view_candidate",
		label: "View candidate",
		description: "Returns a candidate's statistics and available crop images (objects/faces), voice lines, or full conversation transcript. Object/face crops are direct image evidence for details inside the crop; surrounding scene and action over time may be absent. Labels and clustering are provisional identity hints. No returned images means no direct image evidence from this view.",
		parameters: Type.Object({ id: Type.String({ description: "Exact candidate id copied from recall_day or view_episode (conv-…, face-…, voice-…, obj-…); not an episode id or saved memory id. Never invent or reconstruct an id." }) }),
		execute: (_id, p) => call("view_candidate", p),
	}),
	defineTool({
		name: "view_memory",
		label: "View memory",
		description: "Returns an existing memory's description, evidence, links and available cached cover crops; conversations include their full transcript. Descriptions and links are earlier interpretations. Covers show their crop, not the whole scene. These sources can help compare a candidate with an existing entity or re-examine an earlier claim.",
		parameters: Type.Object({ id: Type.String() }),
		execute: (_id, p) => call("view_memory", p),
	}),
	defineTool({
		name: "search_memory",
		label: "Search memory",
		description: "Search existing memory entities by words in name/description/summary. Empty query lists them.",
		parameters: Type.Object({ query: Type.Optional(Type.String()) }),
		execute: (_id, p) => call("search_memory", p),
	}),
	defineTool({
		name: "consolidate",
		label: "Consolidate",
		description:
			"Create or enrich one memory entity (new or into). Create semantic events with remember_event instead. ids are consumed: fragments are deleted, and existing entity identities are merged with their links moved. Voice identity material may be consolidated before or after remember_conversation; original conversation transcripts and media references remain available, and every conversation must still be remembered. evidence only links saved memories to the result; it never consumes or merges them. Use evidence for conversations (remember them first), and reuse the same conversation for multiple entities. At least one consumed id or reusable evidence reference supplies the material; ids may be empty when saved evidence supports a new entity. Never put conversations or diaries in ids.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Identity material to consume: fragment/candidate ids or existing entity ids to merge; never conversations or diaries" })),
			evidence: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ description: "Saved memory id, including conversation:… or a conversation candidate already remembered; kept intact and reusable" }),
				text: Type.String({ minLength: 1, description: "English sentence explaining how this memory supports the target, including the date and relevant statement; distinguish a spoken mention from a visually confirmed identity" }),
			}))),
			into: Type.Optional(Type.String({ description: "existing memory entity id to merge into" })),
			new: Type.Optional(
				Type.Object({
					kind: Type.String({ description: "person | object | place | event | routine | reading" }),
					name: Type.String({ description: "short name in English (e.g. for a black tumbler)" }),
					description: Type.String({ description: "English gist: what it is, roughly how it looks, where/when/how it showed up, why it matters" }),
				}),
			),
			why: Type.String({ description: "why this is worth remembering" }),
		}),
		execute: (_id, p) => call("consolidate", p),
	}),
	defineTool({
		name: "remember_event",
		label: "Remember event",
		description: "Saves a semantic event and media interval bounded by inspected archive windows in time order within one capture; it may span physical episodes and does not consume source material. The description represents occurrences supported within that interval, at window precision. Related material outside it is context. An existing event may already represent the occurrence; revising its description does not change its stored interval.",
		parameters: Type.Object({
			first: Type.String({ description: "Exact archive_window_id value of the first included evidence row returned by view_episode. Not an episode:… id." }),
			last: Type.String({ description: "Exact archive_window_id value of the last included evidence row returned by view_episode. Not an episode:… id." }),
			title: Type.String({ description: "Short English event title" }),
			description: Type.String({ description: "English account of what happened, what evidence supports the boundaries, and any source/timing uncertainty" }),
			evidence: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ description: "Existing saved memory or remembered conversation candidate id; kept intact" }),
				text: Type.String({ minLength: 1, description: "English sentence explaining its support, with date; distinguish a recorded broadcast from an in-person interaction" }),
			}))),
		}),
		execute: (_id, p) => call("remember_event", p),
	}),
	defineTool({
		name: "remember_conversation",
		label: "Remember conversation",
		description: "Turn one conversation candidate into a conversation entity, preserving its full original transcript and media references. Voice identity material stays available for consolidate if not already consumed. You write the title and a detailed summary (who, what, decisions, open questions). Every conversation must be remembered tonight. If a speaker identity is consolidated later, finish resolves its voice label and links the person to the conversation.",
		parameters: Type.Object({
			id: Type.String({ description: "conv-… candidate id" }),
			title: Type.String({ description: "short English title" }),
			summary: Type.String({ description: "English summary, detailed for tonight" }),
			participants: Type.Optional(Type.Array(Type.String(), { description: "person/voice memory ids or voice/face candidate ids already consolidated" })),
			why: Type.Optional(Type.String()),
		}),
		execute: (_id, p) => call("remember_conversation", p),
	}),
	defineTool({
		name: "forget",
		label: "Forget",
		description: "Delete fragments that are not worth keeping (misdetections, things glimpsed in passing, noise) and memory entities not worth keeping long-term. Conversations and person:owner cannot be forgotten. Raw video stays archived.",
		parameters: Type.Object({ ids: Ids, why: Type.String() }),
		execute: (_id, p) => call("forget", p),
	}),
	defineTool({
		name: "link",
		label: "Link",
		description:
			"Connect two memory entities. A pair has exactly one link, and a link is only plain English text describing how the two relate, in your own words (e.g. \"the white mug usually sits on the office desk; drank from it in the afternoon\"). Without rewrite the sentence is appended to the pair's link; with rewrite the link's whole text is replaced (empty text removes the link).",
		parameters: Type.Object({
			a: Type.String({ description: "memory entity id (or a candidate already consolidated)" }),
			b: Type.String({ description: "memory entity id (or a candidate already consolidated)" }),
			text: Type.String({ description: "English sentence(s); include the date when it describes something that happened" }),
			rewrite: Type.Optional(Type.Boolean({ description: "replace the whole text instead of appending" })),
		}),
		execute: (_id, p) => call("link", p),
	}),
	defineTool({
		name: "revise",
		label: "Revise",
		description: "Replaces the supplied name/description fields of an existing memory. Facts omitted from a replacement description are lost from that description. New uncertain evidence does not by itself refute independently supported earlier details; different evidence may support different aspects of the entity.",
		parameters: Type.Object({ id: Type.String(), name: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }),
		execute: (_id, p) => call("revise", p),
	}),
	defineTool({
		name: "write_diary",
		label: "Write diary",
		description: "Replaces the day's diary with a coherent first-person English account of the owner's recorded experiences, including supported earlier material. Recordings may cover only parts of the day. refs identify mentioned memories/conversations; time anchors link nearby source media without verifying the sentence's claims. Memory-graph maintenance is system work, not an experience of the owner.",
		parameters: Type.Object({ title: Type.String(), text: Type.String(), refs: Type.Optional(Type.Array(Type.String())) }),
		execute: (_id, p) => call("write_diary", p),
	}),
	defineTool({
		name: "note_period",
		label: "Note period",
		description: "Batch runs only: leave first-person English diary material for this batch's stretch of time (what happened, in order, with ⟦HH:MM⟧ anchors). The final run turns all batches' material into the day's diary.",
		parameters: Type.Object({ title: Type.String(), text: Type.String() }),
		execute: (_id, p) => call("note_period", p),
	}),
	defineTool({
		name: "finish_batch",
		label: "Finish batch",
		description: "Batch runs only: end this batch and hand the working memory to the next batch. Fails if a conversation of this batch is not remembered or note_period was not written.",
		parameters: Type.Object({}),
		execute: (_id, p) => call("finish_batch", p),
	}),
	defineTool({
		name: "finish",
		label: "Finish",
		description: "End the night. Fails if a conversation is not remembered or the diary is missing. Every perceptual fragment you did not consolidate fades away.",
		parameters: Type.Object({}),
		execute: (_id, p) => call("finish", p),
	}),
];

export default function (pi: ExtensionAPI) {
	for (const t of tools) pi.registerTool(t);
}
