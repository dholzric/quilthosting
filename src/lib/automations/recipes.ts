/**
 * One-click automation recipes (phase 3, Task E).
 *
 * A recipe is nothing but a named set of steps on a trigger. Installing one
 * writes an ordinary row in automation_sequences, so the guild can rename it,
 * rewrite the copy, add or remove steps, pause it or delete it afterwards —
 * there is no "recipe mode" the sequence can get stuck in. The only trace of
 * its origin is `recipe` in trigger_config_json, used to show "installed" in
 * the admin and to refuse installing the same one twice.
 *
 * Copy rules: plain sentences a volunteer officer would actually send, merge
 * fields limited to the ones every subject can resolve ({{first_name}},
 * {{guild_name}}), and no promises the product cannot keep.
 */
import type { AutomationStep } from "./steps";
import { parseSteps } from "./steps";
import type { TriggerName } from "./triggers";

export const RECIPE_IDS = [
  "welcome_series",
  "renewal_ladder",
  "post_event_thank_you",
  "win_back",
] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

export type RecipeStep = {
  waitDays: number;
  subject: string;
  bodyHtml: string;
};

export type Recipe = {
  id: RecipeId;
  name: string;
  /** One sentence, shown on the card. */
  description: string;
  trigger: TriggerName;
  steps: RecipeStep[];
};

const p = (...lines: string[]) => lines.map((l) => `<p>${l}</p>`).join("");

export const RECIPES: Recipe[] = [
  {
    id: "welcome_series",
    name: "Welcome series",
    description:
      "Three notes over two weeks that get a brand-new member to their first meeting.",
    trigger: "member_activated",
    steps: [
      {
        waitDays: 0,
        subject: "Welcome to {{guild_name}}!",
        bodyHtml: p(
          "Hi {{first_name}}, welcome to {{guild_name}} — we are glad you joined.",
          "Your membership is active. You can see your details, renew, and sign up for events from your member portal any time.",
          "If you have a question, just reply to this email; a real person reads it."
        ),
      },
      {
        waitDays: 3,
        subject: "What happens at a {{guild_name}} meeting",
        bodyHtml: p(
          "Hi {{first_name}}, here is what a typical meeting looks like so nothing is a surprise.",
          "Bring whatever you are working on — finished or not. Most people arrive a few minutes early to say hello.",
          "Have a look at what is coming up on our events page and pick one that suits you."
        ),
      },
      {
        waitDays: 14,
        subject: "Come to your first {{guild_name}} event",
        bodyHtml: p(
          "Hi {{first_name}}, you have been a member for two weeks now.",
          "The easiest way to meet people is to come to one thing. Pick any event on the calendar and register — beginners are welcome at all of them.",
          "Hope to see you there."
        ),
      },
    ],
  },
  {
    id: "renewal_ladder",
    name: "Renewal ladder",
    description:
      "Three reminders over three weeks after a membership lapses, each a little more direct.",
    trigger: "membership_lapsed",
    steps: [
      {
        waitDays: 0,
        subject: "Your {{guild_name}} membership has ended",
        bodyHtml: p(
          "Hi {{first_name}}, your membership with {{guild_name}} ended today.",
          "Renewing takes a minute in your member portal and picks up exactly where you left off.",
          "If you meant to let it lapse, no problem at all — this is the last thing you need to do."
        ),
      },
      {
        waitDays: 7,
        subject: "Still time to renew with {{guild_name}}",
        bodyHtml: p(
          "Hi {{first_name}}, a quick nudge: your membership is still lapsed.",
          "Members get the newsletter, member pricing on events, and the member area of the website.",
          "Renew from your portal whenever you are ready."
        ),
      },
      {
        waitDays: 21,
        subject: "Last reminder from {{guild_name}}",
        bodyHtml: p(
          "Hi {{first_name}}, this is the last renewal reminder we will send.",
          "You are welcome back any time — nothing expires and your history stays on file.",
          "Thank you for the time you spent with us."
        ),
      },
    ],
  },
  {
    id: "post_event_thank_you",
    name: "Post-event thank-you",
    description:
      "Thanks everyone who attended the day after, then asks for one line of feedback.",
    trigger: "event_ended",
    steps: [
      {
        waitDays: 1,
        subject: "Thanks for coming, {{first_name}}",
        bodyHtml: p(
          "Thank you for joining us at {{guild_name}} — it was better for having you there.",
          "Photos usually go up on the website within a few days.",
          "The next event is already on the calendar if you would like to come again."
        ),
      },
      {
        waitDays: 7,
        subject: "One question about our last event",
        bodyHtml: p(
          "Hi {{first_name}}, one question and then we will leave you alone: what would have made that event better?",
          "Reply with a single line. We read every one and it genuinely changes what we plan next."
        ),
      },
    ],
  },
  {
    id: "win_back",
    name: "Win-back",
    description:
      "Two friendly notes two and three months after someone lapses, with no pressure.",
    trigger: "membership_lapsed",
    steps: [
      {
        waitDays: 60,
        subject: "We have missed you at {{guild_name}}",
        bodyHtml: p(
          "Hi {{first_name}}, it has been a couple of months since your membership with {{guild_name}} ended.",
          "A lot has happened since — new events, new faces, and the same welcome as always.",
          "If life has settled down, we would love to have you back."
        ),
      },
      {
        waitDays: 90,
        subject: "The door is still open",
        bodyHtml: p(
          "Hi {{first_name}}, no sales pitch: just a note that {{guild_name}} is still here and you are still welcome.",
          "Come to a meeting as a guest first if you would rather try before rejoining.",
          "This is the last email in this series."
        ),
      },
    ],
  },
];

export function findRecipe(id: string): Recipe | null {
  return RECIPES.find((r) => r.id === id) || null;
}

/**
 * The row body for a one-click install. `active_from` is set to now so an
 * install can never back-fill members who joined or lapsed months ago.
 */
export function recipeToSequence(
  recipe: Recipe,
  now: string = new Date().toISOString()
): {
  name: string;
  trigger_event: TriggerName;
  steps: AutomationStep[];
  conditions: null;
  trigger_config: { recipe: RecipeId; active_from: string };
} {
  return {
    name: recipe.name,
    trigger_event: recipe.trigger,
    // Round-trip through parseSteps so an installed recipe is validated and
    // clamped by exactly the same code path as a hand-built sequence.
    steps: parseSteps(JSON.stringify(recipe.steps)),
    conditions: null,
    trigger_config: { recipe: recipe.id, active_from: now },
  };
}
