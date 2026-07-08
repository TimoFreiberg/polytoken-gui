import type { ImageContent } from "@pantoken/protocol";

// Shared full-screen image viewer. Any read-only transcript image — a user
// attachment, a tool's image output — opens the single ImageLightbox mounted in
// App.svelte by calling imageViewer.open(batch, index). The batch is the image set
// the clicked thumbnail belongs to, so the lightbox's ←/→ walk just those images.
//
// The composer keeps its own local lightbox instead of routing through here: its
// batch is mutable (removing an attachment re-syncs the open index), which the
// immutable transcript never needs.
class ImageViewer {
  images = $state<readonly ImageContent[]>([]);
  // null = closed. Index into `images` when open.
  index = $state<number | null>(null);

  open(images: readonly ImageContent[], index: number): void {
    if (images.length === 0) return;
    this.images = images;
    this.index = Math.min(Math.max(index, 0), images.length - 1);
  }

  setIndex(i: number): void {
    this.index = i;
  }

  close(): void {
    this.index = null;
  }
}

export const imageViewer = new ImageViewer();
