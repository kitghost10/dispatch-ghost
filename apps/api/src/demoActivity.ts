import { DEMO_BUSINESS_NUMBER } from "@sb/db";
import { CallDriver, inboundSms, missedCall, parseDial } from "./dev/callDriver";
import type { AppContext } from "./context";
import { MockTelephony } from "@sb/providers";

/**
 * Mock mode: drive a handful of realistic calls through the real webhook +
 * media-stream path so the dashboard has something to show.
 */
export async function seedDemoActivity(ctx: AppContext, baseUrl: string) {
  const to = DEMO_BUSINESS_NUMBER;
  const run = async (from: string, lines: string[], after?: (d: CallDriver) => Promise<void>) => {
    const d = new CallDriver({ baseUrl, from, to });
    await d.start();
    for (const line of lines) {
      if (!(await d.say(line)) && d.agent.length && /Take care|911|right now|call you/.test(d.agent.at(-1)!)) break;
    }
    if (after) await after(d);
    await d.end("completed", 90);
  };
  await run("+15125550143", ["Hi, my kitchen sink is completely clogged and won't drain", "no, just the one sink", "78704", "the first one", "Maria Lopez", "1402 South Congress Avenue, Austin 78704", "yes", "yes please", "no that's it, thanks"]);
  await run("+15125550144", ["I smell gas near my water heater, really strong"]);
  await run("+15125550145", ["how much do you charge to fix a leaky faucet?", "it's the bathroom faucet dripping", "I'm just calling around for a price"]);
  await run("+15125550146", ["our water heater stopped working, no hot water at all and we have a newborn", "no gas smell", "no leaking", "78745", "the first one", "Tom Nguyen", "88 Brodie Lane 78745", "yes", "yes", "that's all"]);
  await run("+15125550147", ["toilet's clogged", "just the one", "76101"]);
  await run("+15125550148", ["A pipe burst in the ceiling and water is pouring into the utility room next to the breaker panel"]);
  // After-hours-style transfer failure only happens at night; the demo keeps whatever the clock says.
  const tel = ctx.telephony;
  await run("+15125550149", ["water is spraying from a burst pipe under the sink", "no, nowhere near outlets", "yes, it's still spraying", "I found it and turned it off", "78702"], async (d) => {
    const dial = tel instanceof MockTelephony ? tel.liveCallUpdates.filter((u) => u.callSid === d.callSid).map((u) => parseDial(u.twiml)).find(Boolean) : null;
    if (dial) {
      await d.stopStream();
      const next = await d.dialResult(dial.action, "no-answer");
      const second = parseDial(next);
      if (second) await d.dialResult(second.action, "no-answer");
    }
  });
  const missedFrom = "+15125550150";
  await missedCall(baseUrl, missedFrom, to);
  await inboundSms(baseUrl, missedFrom, to, "yes my water heater is leaking from the bottom");
}
