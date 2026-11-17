import { google } from "@ai-sdk/google";
import { generateText, isStepCount, tool } from "ai";
import { TOOLS } from "./tools";

/**
 * The lead-discovery agent.
 *
 * Division of labour:
 * - The model decides which tools to call and writes the explanation.
 * - Every count, property and permit comes from a tool, which runs SQL over
 *   the published snapshot. The model is told to state nothing it did not get
 *   from a tool, and the tool calls are returned beside the answer so a reader
 *   can check it against the records.
 */

// Tried in order. Measured on the free tier: the newest models time out or return
// "high demand", so the default is the one that answers a tool call in about a second.
const MODELS = (process.env.AGENT_MODELS ?? "gemini-3.5-flash-lite,gemini-3.5-flash").split(",").map((m) => m.trim());
const ATTEMPT_TIMEOUT_MS = 50_000;

const SYSTEM = `You help a roofing company find leads in Miami-Dade County, Florida, using a published dataset of county property, permit and contractor records.

Rules:
- Use the tools for every fact. Never state a count, address, owner, date or contractor that did not come from a tool result.
- When a question names a place, call find_place first, then search around the coordinates it returns. Use the radius the question gives; if it gives none ("near", "around"), use 3 miles and say so.
- "Older than 15 years" means minRoofAge 15. "Open for many years" means sort by longest open; mention how long each has been open.
- Report the total number of matches and say how many you are listing. List at most 8 items; the full rows are shown to the user beside your answer.
- One search is normally enough. Do not call get_property or query_sql unless the question asks for something the search result does not contain.
- Property results are one row per street address; if matches_at_address is more than 1, say how many units match there.
- For each property say the roof year and its basis: "roof permit" (a completed roof permit) or "year built" (a proxy, since county permits only go back to 2020).
- For each permit give the permit number, issue date, how long it has been open, the derived status, and the contractor name and licence number. If no contractor is printed, say so. BBB ratings are not in the dataset: say that plainly instead of guessing.
- Permit status is derived from inspection dates because the county publishes none. Say "no approved final inspection on record" rather than "open" as a legal fact.
- End with a short "Assumptions and gaps" line listing anything you assumed and any data the question needed that is missing.
- Be concise. Use short lists, not long paragraphs.`;

export interface AgentStep {
  tool: string;
  input: unknown;
  output: unknown;
}

export async function askAgent(question: string): Promise<{ answer: string; steps: AgentStep[]; model: string }> {
  let lastError: unknown;
  for (const model of MODELS) {
    try {
      return await askWith(model, question);
    } catch (error) {
      lastError = error;
      console.error(`Agent model ${model} failed:`, error instanceof Error ? error.message : error);
    }
  }
  throw new Error(`The language model is unavailable right now (${lastError instanceof Error ? lastError.message : "unknown error"}). The data tools on this page still work.`);
}

async function askWith(model: string, question: string): Promise<{ answer: string; steps: AgentStep[]; model: string }> {
  const steps: AgentStep[] = [];
  const tools = Object.fromEntries(
    TOOLS.map((spec) => [
      spec.name,
      tool({
        description: spec.description,
        inputSchema: spec.inputSchema,
        execute: async (input: unknown) => {
          const output = await (spec.run as (input: unknown) => Promise<unknown>)(input);
          steps.push({ tool: spec.name, input, output });
          return output;
        },
      }),
    ]),
  );
  const result = await generateText({
    model: google(model),
    system: SYSTEM,
    prompt: question,
    tools,
    stopWhen: isStepCount(8),
    temperature: 0,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  return { answer: result.text, steps, model };
}
