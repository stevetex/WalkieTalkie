import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAttempts } from "../src/report.ts";
import type { TimelineEntry } from "../src/store.ts";

const e = (source: TimelineEntry["source"], name: string, t: number): TimelineEntry => ({ source, name, t });

test("an unanswered ring and a later answered ring are summarized separately", () => {
  const timeline = [
    // Ring 1: reported, then dropped without an answer.
    e("sender", "talkPressed", 0),
    e("server", "pushSent", 1),
    e("receiver", "pushReceived", 700),
    e("receiver", "callReported", 1900),
    // Ring 2, 100 s later: answered.
    e("sender", "talkPressed", 100_000),
    e("server", "pushSent", 100_002),
    e("receiver", "pushReceived", 100_500),
    e("receiver", "callReported", 100_500),
    e("receiver", "answerTapped", 106_500),
    e("receiver", "firstAudioScheduled", 107_600),
  ];
  const [first, second] = summarizeAttempts(timeline);
  const get = (a: typeof first, label: string) => a.intervals.find((i) => i.label === label)?.ms;

  assert.equal(get(first, "Watch: push → call reported"), 1200);
  assert.equal(get(first, "Human: ring → answer tap"), undefined);
  assert.equal(get(second, "Human: ring → answer tap"), 6000);
  assert.equal(get(second, "Watch: answer → first audio"), 1100);
  assert.equal(get(second, "Total: press → first audio (cross-device)"), 7600);
});

test("an option C ring measures delivery and leaves out the time before the tap", () => {
  const timeline = [
    e("sender", "talkPressed", 0),
    e("server", "pushSent", 2),
    e("receiver", "notificationDelivered", 600),
    e("receiver", "notificationOpened", 5_600),
    e("receiver", "answerTapped", 5_600),
    e("receiver", "firstAudioScheduled", 8_100),
  ];
  const [ring] = summarizeAttempts(timeline);
  const get = (label: string) => ring.intervals.find((i) => i.label === label)?.ms;

  assert.equal(get("Push sent → notification delivered (cross-device)"), 598);
  assert.equal(get("Notification: opened → first audio"), 2500);
  // 8.1 s from the push, minus the 5 s the notification waited for a tap.
  assert.equal(get("Total: push sent → first audio, minus human answer time"), 3098);
});
