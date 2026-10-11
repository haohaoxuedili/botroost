import { describe, expect, it } from "vitest";
import { ProviderCapabilityManifestSchema } from "@botroost/provider-sdk";
import {
  llbotAvailability,
  llbotManifest,
  LLBotConfigurationSchema,
  LLBotCredentialsSchema,
  redactLLBotConfiguration,
} from "../src/index.js";

describe("LLBot adapter", () => {
  it("has a valid manifest", () => {
    expect(ProviderCapabilityManifestSchema.safeParse(llbotManifest).success).toBe(true);
  });

  it("declares configure and observe capabilities", () => {
    expect(llbotManifest.capabilities).toEqual(["configure", "observe"]);
    expect(llbotManifest.credentialTransport).toBe("provider-api");
    expect(llbotManifest.id).toBe("llbot");
    expect(llbotManifest.displayName).toBe("LLBot");
  });

  it("is unavailable until licensing and verified artifact policy are configured", () => {
    expect(llbotAvailability.available).toBe(false);
    expect(llbotAvailability.runtimeRequest).toBeNull();
    expect(llbotAvailability.requirements).toEqual(
      expect.arrayContaining([
        "llbot-license-accepted",
        "verified-artifact-policy",
      ]),
    );
  });

  it("does not expose a runnable image reference", async () => {
    const module = await import("../src/index.js");
    expect(JSON.stringify(module)).not.toMatch(/sha256|llbot:/);
  });

  it("separates credential schema from ordinary configuration", () => {
    expect(() =>
      LLBotConfigurationSchema.parse({
        endpointUrl: "http://provider.invalid",
        accessToken: "secret",
      }),
    ).toThrow();
    expect(LLBotCredentialsSchema.parse({ accessToken: "secret" })).toEqual({ accessToken: "secret" });
    expect(redactLLBotConfiguration({ endpointUrl: "http://provider.invalid" })).toEqual({ endpointUrl: "http://provider.invalid/" });
  });

  it("redacts credential-like values recursively", () => {
    expect(redactLLBotConfiguration({ endpointUrl: "http://u:p@host/x?token=abc" } as never)).toEqual({ endpointUrl: "http://host/x?token=%5BREDACTED%5D" });
  });
});
