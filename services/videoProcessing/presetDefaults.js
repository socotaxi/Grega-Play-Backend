export const DEFAULT_PRESET = {
  transition: "modern_1", // placeholder
  music: {
    mode: "none", // none | full | intro_outro
    trackUrl: null,
    volume: 0.6,
  },
  intro: {
    enabled: true,
    type: "default", // default | custom_image | custom_text
    imageUrl: null,
    text: null,
  },
  outro: {
    enabled: true,
    type: "default",
    imageUrl: null,
    text: null,
  },
};
