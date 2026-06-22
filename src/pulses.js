// Pulse templates — kept short, atmospheric, shill-culture themed.
// Each template has a rarity weight. Higher weight = more common.
// All templates now use a single shared action ("im_in") and label
// ("I'm in") — having two buttons gave identical points either way,
// which made the choice meaningless. One clear action is more honest.

const SINGLE_BUTTON = [{ label: "I'm in", action: "im_in" }];

export const PULSE_TEMPLATES = [
  {
    type: "conviction",
    rarity: "common",
    weight: 10,
    text: "Conviction is forming somewhere in this chat. Most won't notice in time.",
    buttons: SINGLE_BUTTON,
  },
  {
    type: "static",
    rarity: "common",
    weight: 10,
    text: "Static on the chart. The candle moved. Nobody knows why.",
    buttons: SINGLE_BUTTON,
  },
  {
    type: "bagholder_signal",
    rarity: "common",
    weight: 8,
    text: "Someone here has diamond hands nobody's confirmed yet.",
    buttons: SINGLE_BUTTON,
  },
  {
    type: "whisper",
    rarity: "uncommon",
    weight: 5,
    text: "A whisper just passed through the group. It said nothing. That's the point.",
    buttons: SINGLE_BUTTON,
  },
  {
    type: "rug_echo",
    rarity: "uncommon",
    weight: 4,
    text: "An old rug pull is echoing somewhere in the chain. It is not yours. Yet.",
    buttons: SINGLE_BUTTON,
  },
  {
    type: "fracture",
    rarity: "rare",
    weight: 2,
    text: "Cons̸ensus integrity is collapsing in a corner of this chat nobody is watching.",
    buttons: SINGLE_BUTTON,
  },
  {
    type: "ghost_pulse",
    rarity: "rare",
    weight: 1,
    text: "This Pulse should not exist. It is already expiring.",
    buttons: SINGLE_BUTTON,
  },
  {
    // Alpha Pulse — the rarest tier. Fires very infrequently (lowest
    // weight) and awards bonus Conviction when caught, so being quick on
    // one feels like genuinely catching alpha. Identified by this exact
    // type string in the points logic.
    type: "alpha_pulse",
    rarity: "alpha",
    weight: 1,
    text: "⚡ ALPHA PULSE ⚡\nThis one's rare. If you're seeing it, you're early. Move.",
    buttons: SINGLE_BUTTON,
  },
];

// Bonus Conviction added on top of the normal tap reward when the Pulse
// caught is an Alpha Pulse. Kept here next to the template so the special
// behaviour is defined in one place.
export const ALPHA_PULSE_TYPE = "alpha_pulse";
export const ALPHA_PULSE_BONUS = 5;

export function pickPulseTemplate() {
  const totalWeight = PULSE_TEMPLATES.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const template of PULSE_TEMPLATES) {
    roll -= template.weight;
    if (roll <= 0) return template;
  }
  return PULSE_TEMPLATES[0];
}

export const PULSE_DURATIONS_MINUTES = [5, 15, 30, 60];

export function pickDurationMinutes() {
  return PULSE_DURATIONS_MINUTES[
    Math.floor(Math.random() * PULSE_DURATIONS_MINUTES.length)
  ];
}
