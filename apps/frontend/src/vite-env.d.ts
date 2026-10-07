/// <reference types="vite/client" />

// vite-imagetools: `?...&as=picture` imports resolve to responsive <picture> metadata.
declare module '*&as=picture' {
  const picture: {
    sources: Record<string, string>;
    img: { src: string; w: number; h: number };
  };
  export default picture;
}
