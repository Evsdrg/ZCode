export const imagePreviewEditorModule = {
  id: "image-preview-editor",
  requires: ["shared", "ui"],
  provides: ["image-preview-editor"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
