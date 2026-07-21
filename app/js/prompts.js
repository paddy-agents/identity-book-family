/*
 * The prompt set is the product's core IP. Redesigned 2026-07-09 after reading
 * two real hand-made "identity books" a parent shared with us (see
 * docs/inspiration/). Those books taught us the real pattern: NOT long
 * paragraphs, but a curated picture book made of many small, specific facts —
 * parents' names, siblings by name, the pet, the state you traveled to, how
 * many weeks you waited. Small inputs, not essay prompts. See
 * docs/brief.md and docs/roadmap.md for the wider product principles
 * (joy-framed, simple, age-appropriate, always ends in an unconditional promise).
 *
 * Every field below is deliberately short: a name, a select, a phrase. The
 * page templates in js/app.js do the sentence-building.
 */

const STORY_TYPES = [
  {
    id: 'adoption',
    label: 'Adoption',
    defaultTitle: 'How Our Family Grew',
    ideaLabel: 'A Family Made by Adoption',
  },
  {
    id: 'surrogacy',
    label: 'Surrogacy',
    defaultTitle: 'How Our Family Grew',
    ideaLabel: 'A Little Help From a Surrogate',
  },
  {
    id: 'ivf',
    label: 'IVF',
    defaultTitle: 'How We Became Us',
    ideaLabel: 'A Little Help From Science',
  },
  {
    id: 'blended',
    label: 'Blended Family',
    defaultTitle: 'How Our Family Grew',
    ideaLabel: 'Becoming One Family',
  },
];

const SEASONS = ['spring', 'summer', 'fall', 'winter'];

const PARENT_LABEL_OPTIONS = [
  'Mommy and Daddy',
  'Mommy and Mommy',
  'Daddy and Daddy',
  'Mommy',
  'Daddy',
  'Mama and Papa',
  'Other',
];

// Adoption happens by more than one path, and forcing every family into a
// "birth mom chose you" narrative misrepresents the ones that didn't happen
// that way (foster care, international, kinship) — see
// docs/adoption-language-review.md. The origin sentence in js/app.js
// branches on this field instead of assuming one story fits everyone.
const ADOPTION_PATH_OPTIONS = [
  'A birth parent chose us',
  'Foster care',
  'International adoption',
  'Kinship / relative adoption',
];

// Small, curated fields every book needs, regardless of story type.
const FAMILY_FIELDS = [
  {
    id: 'childName',
    label: "Child's name",
    type: 'text',
    placeholder: 'e.g. Maya',
    required: true,
    maxLength: 40,
  },
  {
    id: 'bookTitle',
    label: 'Book title',
    hint: 'A default is filled in — change it if you like.',
    type: 'text',
    // Overridden per story type in renderFields() (see app.js) so it always
    // matches that type's actual defaultTitle fallback — this static value is
    // only a safety net if that lookup somehow fails.
    placeholder: 'How Our Family Grew',
    maxLength: 60,
  },
  {
    id: 'childPhoto',
    label: "A photo of your child",
    hint: 'Optional — appears on the cover of the book. Stays in your browser, never uploaded anywhere. Skip it and we’ll use the avatar below instead.',
    type: 'photo',
    required: false,
  },
  {
    id: 'childAvatar',
    label: "Build your child's look",
    hint: 'A simple cartoon avatar, shown as a baby and with your family at the end of the book — and on the cover if you skip the photo above.',
    type: 'avatar',
    required: false,
  },
  {
    id: 'parentsLabel',
    label: 'What does your child call their parents?',
    type: 'select',
    options: PARENT_LABEL_OPTIONS,
    default: PARENT_LABEL_OPTIONS[0],
    required: true,
  },
  {
    id: 'parentsLabelCustom',
    label: 'Your own words for it',
    type: 'text',
    placeholder: 'e.g. Grandma and Grandpa',
    showIf: (a) => a.parentsLabel === 'Other',
    required: true,
    // Unlike a single name, this field routinely holds a whole list of
    // caregivers (getParentsList() supports splitting on ,/&/;// and "and" —
    // see js/app.js) — a plain 40-char cap silently truncated a natural
    // 6-name list mid-word into garbled prose ("...Papa Kim, and an A."),
    // found live 2026-07-21. 80 comfortably fits several short names while
    // still bounding PDF layout the way every other field's cap does.
    maxLength: 80,
  },
  {
    id: 'numSiblings',
    label: 'How many siblings were already part of the family?',
    hint: 'The brothers and sisters already waiting to meet this child.',
    type: 'select',
    options: ['0', '1', '2', '3', '4'],
    default: '0',
  },
  {
    id: 'petName',
    label: "Family pet's name",
    type: 'text',
    placeholder: 'e.g. Biscuit (leave blank if none)',
    required: false,
    maxLength: 40,
  },
  {
    id: 'season',
    label: 'What season does the story start in?',
    type: 'select',
    options: SEASONS,
    default: 'spring',
  },
];

// One sibling-name field per sibling; generated dynamically from numSiblings
// (see js/app.js). Kept here as the single source of the field shape.
function siblingField(index) {
  return {
    id: 'siblingName' + index,
    label: 'Sibling ' + index + "'s name",
    type: 'text',
    placeholder: 'e.g. Danny',
    required: true,
    maxLength: 40,
  };
}

// Story-type-specific "origin" fields — short, true, age-appropriate facts,
// not essays. Kept to a handful of small inputs per type.
const ORIGIN_FIELDS = {
  adoption: [
    {
      id: 'adoptionPath',
      label: 'How did your child join your family?',
      hint: 'Every path is a real one — this shapes how we tell the story.',
      type: 'select',
      options: ADOPTION_PATH_OPTIONS,
      default: ADOPTION_PATH_OPTIONS[0],
    },
    {
      id: 'birthParentTerm',
      label: 'What do you call the birth family?',
      type: 'select',
      options: ['birth mom', 'birth parents', 'birth family'],
      default: 'birth mom',
      showIf: (a) => !a.adoptionPath || a.adoptionPath === ADOPTION_PATH_OPTIONS[0],
    },
    {
      id: 'travelPlace',
      label: 'Where did you travel to meet your child?',
      hint: 'A city or state — optional, skip if there was no trip.',
      type: 'text',
      placeholder: 'e.g. Virginia',
      required: false,
      maxLength: 40,
    },
    {
      id: 'travelDuration',
      label: 'How long was the trip or wait?',
      type: 'text',
      placeholder: 'e.g. 2 weeks',
      required: false,
      maxLength: 30,
    },
    {
      id: 'joyfulDetail',
      label: "One joyful detail about your child's birth family",
      hint: 'A name, a shared trait, a kindness. Optional — skip if it doesn’t feel right yet.',
      type: 'text',
      placeholder: 'e.g. Your birth mom loves music, just like you do.',
      required: false,
      maxLength: 120,
    },
  ],
  surrogacy: [
    {
      id: 'helperTerm',
      label: 'What do you call the person who carried your child?',
      type: 'select',
      options: ['surrogate', 'gestational carrier', 'surrogate mom'],
      default: 'surrogate',
    },
    {
      id: 'travelPlace',
      label: 'Where did you travel to meet your child?',
      hint: 'A city or state — optional, skip if there was no trip.',
      type: 'text',
      placeholder: 'e.g. Rhode Island',
      required: false,
      maxLength: 40,
    },
    {
      id: 'travelDuration',
      label: 'How long was the trip or wait?',
      type: 'text',
      placeholder: 'e.g. 5 weeks',
      required: false,
      maxLength: 30,
    },
    {
      id: 'joyfulDetail',
      label: 'One joyful detail about the person who carried your child',
      type: 'text',
      placeholder: 'e.g. She sang to you every night before bed.',
      required: false,
      maxLength: 120,
    },
  ],
  ivf: [
    {
      id: 'helperDetail',
      label: 'How did your family get help? (a short phrase)',
      type: 'text',
      placeholder: 'e.g. a wonderful doctor and a little bit of science',
      default: 'a little help from science',
      required: true,
      maxLength: 120,
    },
    // Donor-conception research is consistent that this should be named
    // plainly and early, not left out — see docs/family-language-review.md.
    // A dedicated select (rather than burying it in the optional field
    // below) makes "no donor" and "yes, honestly say so" equally easy.
    {
      id: 'donorInvolved',
      label: 'Did a donor help your family — an egg, sperm, or embryo gift?',
      hint: 'Experts encourage naming this plainly and early rather than leaving it out. Your answer shapes the story of how your family came to be.',
      type: 'select',
      options: ['No — just science and us', 'Yes — an egg or sperm donor', 'Yes — a donor embryo'],
      default: 'No — just science and us',
    },
    {
      id: 'joyfulDetail',
      label: 'One joyful detail about your journey to your child (a milestone, a keepsake)',
      type: 'text',
      placeholder: 'e.g. We kept the positive test in a memory box.',
      required: false,
      maxLength: 120,
    },
  ],
  blended: [
    {
      id: 'howCame',
      label: 'How did your two families come together? (a short phrase, starting with a verb)',
      type: 'text',
      placeholder: 'e.g. met, fell in love, and became one family',
      default: 'met, fell in love, and became one family',
      required: true,
      maxLength: 120,
    },
    {
      id: 'joyfulDetail',
      label: 'One joyful detail about the family you joined',
      type: 'text',
      placeholder: 'e.g. Your new brother taught you to ride a bike.',
      required: false,
      maxLength: 120,
    },
  ],
};

// Closing fields, shared across all story types.
const CLOSING_FIELDS = [
  {
    id: 'promise',
    label: 'A promise to your child',
    hint: 'Every Origin Story ends the same way: an unconditional promise. Keep it to one line.',
    type: 'text',
    placeholder: 'You are safe. You are loved. You are ours — always.',
    default: 'You are safe. You are loved. You are ours — always.',
    required: true,
    maxLength: 140,
  },
  {
    id: 'signOff',
    label: 'A personal sign-off',
    hint: 'The way a real handmade book ends: "I love you, Maya! XO, Mom."',
    type: 'text',
    placeholder: 'I love you! XO, Mom',
    required: false,
    maxLength: 80,
  },
];

function getOriginFieldsFor(storyTypeId) {
  return ORIGIN_FIELDS[storyTypeId] || ORIGIN_FIELDS.adoption;
}

// Full ordered field list for a story type, EXCLUDING the dynamic sibling-name
// fields (js/app.js inserts those after numSiblings based on its current value).
function getFieldsFor(storyTypeId) {
  return [...FAMILY_FIELDS, ...getOriginFieldsFor(storyTypeId), ...CLOSING_FIELDS];
}

// Clamps a raw numSiblings value into the range the field's own <select>
// actually offers. Without this, an out-of-range value (e.g. hand-edited or
// corrupted localStorage) generates one sibling-name field per count with no
// upper bound — a real, reachable failure mode since numSiblings is read
// straight from saved state, not re-validated against the select options.
function clampSiblingCount(raw) {
  const max = Math.max(...FAMILY_FIELDS.find((f) => f.id === 'numSiblings').options.map(Number));
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}
