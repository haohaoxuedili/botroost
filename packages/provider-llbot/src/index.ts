import { z } from "zod";
import { asProviderId } from "@botroost/contracts";
import { redactSecrets, type ProviderCapabilityManifest } from "@botroost/provider-sdk";

export const llbotManifest: ProviderCapabilityManifest = {
  id: asProviderId("llbot"),
  displayName: "LLBot",
  capabilities: ["configure", "observe"],
  credentialTransport: "provider-api",
  runtimeRequirements: [
    "llbot-license-accepted",
    "verified-artifact-policy",
    "isolated-network",
    "ephemeral-storage",
  ],
};

export const llbotAvailability = {
  available: false as const,
  runtimeRequest: null,
  requirements: llbotManifest.runtimeRequirements,
};

/** LLBot exposes its WebUI and OneBot 11 service over plain HTTP inside its own container. */
export const LLBotConfigurationSchema = z.strictObject({
  endpointUrl: z.string().url().startsWith("http://"),
});

export const LLBotCredentialsSchema = z.strictObject({
  accessToken: z.string().min(1),
});

export type LLBotConfiguration = z.infer<typeof LLBotConfigurationSchema>;

export const redactLLBotConfiguration = (
  config: LLBotConfiguration,
): LLBotConfiguration => redactSecrets(config) as LLBotConfiguration;
