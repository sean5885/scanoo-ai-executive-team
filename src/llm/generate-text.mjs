import {
  llmApiKey,
  llmBaseUrl,
  llmModel,
  llmTemperature,
  llmTopP,
} from "../config.mjs";
import { callOpenClawTextGeneration, normalizeAbortSignal } from "../openclaw-text-service.mjs";

export async function generateText({
  systemPrompt = "",
  prompt = "",
  sessionIdSuffix = "default",
  temperature = llmTemperature,
  topP = llmTopP,
  signal = null,
} = {}) {
  const abortSignal = normalizeAbortSignal(signal);

  if (!llmApiKey) {
    const request = {
      systemPrompt,
      prompt,
      sessionIdSuffix,
    };

    if (abortSignal) {
      request.signal = abortSignal;
    }

    return callOpenClawTextGeneration(request);
  }

  const requestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model: llmModel,
      temperature,
      top_p: topP,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
  };

  if (abortSignal) {
    requestInit.signal = abortSignal;
  }

  const response = await fetch(`${llmBaseUrl}/chat/completions`, requestInit);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || `generate_text_failed:${response.status}`);
  }

  return data?.choices?.[0]?.message?.content || "";
}
