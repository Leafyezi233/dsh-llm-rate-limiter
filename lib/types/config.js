/**
 * Rate limiter configuration schema.
 *
 * The settings namespace is "llm-rate-limiter".  Users override values through
 * the DSH settings document; the host merges them on top of `base`.
 *
 * @module dsh-llm-rate-limiter/types/config
 */

import Schema from "@deepseek-ai/schemastery";

/**
 * Per-model overrides — key is `"provider/model"` (e.g. `"deepseek/deepseek-chat"`).
 * Every field is optional; omitted fields inherit from `defaults`.
 */
const ModelOverride = Schema.object({
  maxConcurrent: Schema.number().step(1).min(1).description("Max concurrent requests for this model"),
  maxRpm: Schema.number().step(1).min(1).description("Max requests per minute for this model"),
  burstSize: Schema.number().step(1).min(1).description("Burst capacity for this model (token-bucket)"),
  refillRate: Schema.number().min(0.1).description("Tokens refilled per second (token-bucket)"),
  enabled: Schema.boolean().description("Enable/disable rate limiting for this model"),
});

export const RateLimiterConfig = Schema.object({
  /** Master switch */
  enabled: Schema.boolean().default(true).description("Enable the rate limiter globally"),

  /** Default strategy */
  strategy: Schema.union([
    Schema.const("token-bucket").description("Token Bucket — allows bursts up to burstSize"),
    Schema.const("sliding-window").description("Sliding Window — smooth, fixed requests-per-minute"),
  ]).default("token-bucket").description("Rate limiting algorithm"),

  /** Global defaults — applied to every model unless overridden */
  defaults: Schema.object({
    maxConcurrent: Schema.number().step(1).min(1).default(5).description("Max concurrent requests"),
    maxRpm: Schema.number().step(1).min(1).default(60).description("Max requests per minute"),
    burstSize: Schema.number().step(1).min(1).default(10).description("Burst capacity (token-bucket)"),
    refillRate: Schema.number().min(0.1).default(1).description("Tokens per second (token-bucket)"),
  }).default({}).description("Default limits applied to all models"),

  /** Per-model overrides — key is "provider/model" */
  models: Schema.dict(ModelOverride).description("Per-model rate limit overrides"),

  /** Queue behaviour when a request is throttled */
  onThrottled: Schema.union([
    Schema.const("queue").description("Wait in queue until a slot opens"),
    Schema.const("reject").description("Immediately return an error"),
  ]).default("queue").description("What happens when a request exceeds the limit"),

  /** Maximum time a request waits in queue before being rejected */
  maxQueueWaitMs: Schema.number().step(1).min(1000).default(60_000).description("Max queue wait (ms)"),
}).description("LLM call rate limiter settings");