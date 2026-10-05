import assert from "node:assert/strict";
import { test } from "node:test";
import { fillSavedReply, findMentions, mentionParts, normalizeTag } from "./inbox.ts";

const team = [
  { id: "u1", name: "Ann" },
  { id: "u2", name: "Ann Lee" },
  { id: "u3", name: "Bo" },
  { id: "u4", name: "Jörg" },
];

test("mentions: names match case-insensitively, longest first, whole words only", () => {
  assert.deepEqual(findMentions("@ann can you look?", team), ["u1"]);
  assert.deepEqual(findMentions("cc @Ann Lee and @bo", team), ["u2", "u3"]);
  assert.deepEqual(findMentions("@Anna isn't on the team, @Bob neither", team), []);
  assert.deepEqual(findMentions("mail ann@bo.com", team), [], "an email address is not a mention");
  assert.deepEqual(findMentions("@Jörg, @Bo. @bo again", team), ["u4", "u3"]);
  assert.deepEqual(findMentions("no mentions here", team), []);
});

test("mention parts for highlighting", () => {
  assert.deepEqual(mentionParts("hey @Ann Lee, see this", ["Ann", "Ann Lee"]), [
    { text: "hey ", mention: false },
    { text: "@Ann Lee", mention: true },
    { text: ", see this", mention: false },
  ]);
  assert.deepEqual(mentionParts("@Bo", ["Bo"]), [{ text: "@Bo", mention: true }]);
});

test("saved reply placeholders", () => {
  assert.equal(fillSavedReply("Hi {first_name}, {agent_name} here.", { customerName: "Maria Lopez", agentName: "Nina" }), "Hi Maria, Nina here.");
  assert.equal(fillSavedReply("Hi {first_name}!", { customerName: null, agentName: "Nina" }), "Hi there!");
});

test("tag names", () => {
  assert.equal(normalizeTag("  #Billing   bug "), "Billing bug");
  assert.equal(normalizeTag(""), null);
  assert.equal(normalizeTag("x".repeat(41)), null);
  assert.equal(normalizeTag(3), null);
});
