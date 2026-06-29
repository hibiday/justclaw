import { describe, expect, test } from "bun:test";
import type { QueuedEvent } from "./event-queue";
import { eventToXml } from "./llm-loop";

const id = "0196f4a2-0000-7000-8000-000000000000";

describe("eventToXml", () => {
	test("serializes event.v1 payload fields as XML", () => {
		const event: QueuedEvent = {
			id,
			source: "bluebubbles",
			params: { type: "event.v1", kind: "message.received", text: "hello" },
		};
		const xml = eventToXml(event);
		expect(xml).toContain("<kind>message.received</kind>");
		expect(xml).toContain("<text>hello</text>");
		expect(xml).not.toContain("event.v1");
	});

	test("excludes base64 data from the XML for image.send.v1", () => {
		// Regression: the base64 bytes are delivered as an input_image content
		// part. If they are also serialized into the text XML the same payload is
		// sent twice and can blow past the model context window.
		const data = "QUJDREVG".repeat(1000);
		const event: QueuedEvent = {
			id,
			source: "bluebubbles",
			params: { type: "image.send.v1", data, mediaType: "image/jpeg" },
		};
		const xml = eventToXml(event);
		expect(xml).not.toContain(data);
		expect(xml).not.toContain("<data>");
		expect(xml).toContain("<mediaType>image/jpeg</mediaType>");
	});

	test("excludes base64 data but keeps filename for file.send.v1", () => {
		const data = "QUJDREVG".repeat(1000);
		const event: QueuedEvent = {
			id,
			source: "bluebubbles",
			params: {
				type: "file.send.v1",
				data,
				mediaType: "application/pdf",
				filename: "report.pdf",
			},
		};
		const xml = eventToXml(event);
		expect(xml).not.toContain(data);
		expect(xml).not.toContain("<data>");
		expect(xml).toContain("<filename>report.pdf</filename>");
		expect(xml).toContain("<mediaType>application/pdf</mediaType>");
	});

	test("excludes base64 data but keeps format for audio.send.v1", () => {
		const data = "QUJDREVG".repeat(1000);
		const event: QueuedEvent = {
			id,
			source: "bluebubbles",
			params: {
				type: "audio.send.v1",
				data,
				mediaType: "audio/wav",
				format: "wav",
			},
		};
		const xml = eventToXml(event);
		expect(xml).not.toContain(data);
		expect(xml).not.toContain("<data>");
		expect(xml).toContain("<format>wav</format>");
		expect(xml).toContain("<mediaType>audio/wav</mediaType>");
	});
});
