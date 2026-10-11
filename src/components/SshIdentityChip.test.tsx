import { describe, expect, it } from "vitest";
import { sshIdentityWarning } from "./SshIdentityChip";

describe("sshIdentityWarning", () => {
  it("matches the server's missing-identity health warning", () => {
    const w = sshIdentityWarning({
      warnings: ["Secrets key is not present yet", "SSH identity is not mounted — key-auth Sparks will fail to poll: anton, son-of-anton"],
    });
    expect(w).toContain("anton, son-of-anton");
  });

  it("returns null when identity is fine or health is absent", () => {
    expect(sshIdentityWarning({ warnings: [] })).toBeNull();
    expect(sshIdentityWarning({ warnings: ["SSH identity is not mounted"] })).toMatch(/not mounted/);
    expect(sshIdentityWarning(null)).toBeNull();
    expect(sshIdentityWarning(undefined)).toBeNull();
  });
});
