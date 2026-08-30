import { describe, expect, it } from "vitest";
import { XxHash32 } from "../src/main/backup/XxHash32";

describe("xxHash32", () => {
  it.each([
    ["", "46947589"],
    ["a", "1426945110"],
    ["abc", "852579327"],
  ])("matches the seed-zero reference vector for %j", (input, expected) => {
    expect(new XxHash32().update(Buffer.from(input)).digestDecimal()).toBe(
      expected,
    );
  });

  it("produces the same result across chunk boundaries", () => {
    const input = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
    const whole = new XxHash32().update(input).digestDecimal();
    const streamed = new XxHash32()
      .update(input.subarray(0, 7))
      .update(input.subarray(7, 19))
      .update(input.subarray(19))
      .digestDecimal();
    expect(streamed).toBe(whole);
  });
});
