export type PreviewKind = "image" | "pdf" | "video" | "audio" | "model" | "cad" | "text";

/** Choose a renderer without interpreting binary media as text. */
export function previewKind(path: string): PreviewKind {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (["mp4", "m4v", "webm", "ogv", "mov"].includes(extension)) return "video";
  if (["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac"].includes(extension)) return "audio";
  if (["stl", "obj", "ply", "glb", "gltf"].includes(extension)) return "model";
  if (["step", "stp", "iges", "igs", "3mf", "fbx", "blend", "vtk", "vtu", "msh", "fcstd"].includes(extension)) return "cad";
  return "text";
}
