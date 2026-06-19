// Pulse templates — kept short, atmospheric, shill-culture themed.
// Each template has a rarity weight. Higher weight = more common.

export const PULSE_TEMPLATES = [
  {
    type: "conviction",
    rarity: "common",
    weight: 10,
    text: "Conviction is forming somewhere in this chat. Most won't notice in time.",
    buttons: [
      { label: "Feel it", action: "feel" },
      { label: "Ignore", action: "ignore" },
    ],
  },
  {
    type: "static",
    rarity: "common",
    weight: 10,
    text: "Static on the chart. The candle moved. Nobody knows why.",
    buttons: [
      { label: "Observe", action: "observe" },
      { label: "Stabilize", action: "stabilize" },
    ],
  },
  {
    type: "bagholder_signal",
    rarity: "common",
    weight: 8,
    text: "Someone here has diamond hands nobody's confirmed yet.",
    buttons: [
      { label: "Witness", action: "witness" },
      { label: "Decode", action: "decode" },
    ],
  },
  {
    type: "whisper",
    rarity: "uncommon",
    weight: 5,
    text: "A whisper just passed through the group. It said nothing. That's the point.",
    buttons: [
      { label: "Listen", action: "listen" },
      { label: "Report Noise", action: "report_noise" },
    ],
  },
  {
    type: "rug_echo",
    rarity: "uncommon",
    weight: 4,
    text: "An old rug pull is echoing somewhere in the chain. It is not yours. Yet.",
    buttons: [
      { label: "Brace", action: "brace" },
      { label: "Decode", action: "decode" },
    ],
  },
  {
    type: "fracture",
    rarity: "rare",
    weight: 2,
    text: "Cons̸ensus integrity is collapsing in a corner of this chat nobody is watching.",
    buttons: [
      { label: "Stabilize", action: "stabilize" },
      { label: "Witness", action: "witness" },
    ],
  },
  {
    type: "ghost_pulse",
    rarity: "rare",
    weight: 1,
    text: "This Pulse should not exist. It is already expiring.",
    buttons: [{ label: "Witness anyway", action: "witness" }],
  },
];

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
