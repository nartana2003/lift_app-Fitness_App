"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./offline/db";

const KEY = "avatar";
const SIZE = 256;

/** "27 November, 2026 at 5:30 pm" */
export function formatWorkoutDate(d: Date): string {
  const month = d.toLocaleDateString("en-GB", { month: "long" });
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${month}, ${d.getFullYear()} at ${h}:${m} ${d.getHours() < 12 ? "am" : "pm"}`;
}

/** Profile picture as a small data URL, kept on this device only. */
export const getAvatar = async (): Promise<string | null> => ((await db.meta.get(KEY))?.value as string | undefined) ?? null;

export async function setAvatar(dataUrl: string | null): Promise<void> {
  if (dataUrl) await db.meta.put({ key: KEY, value: dataUrl });
  else await db.meta.delete(KEY);
}

/** Centre-crops an image file to a small square JPEG data URL. */
export async function resizeAvatar(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  canvas.getContext("2d")!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

export const useAvatar = () => useLiveQuery(() => getAvatar(), [], null);

/** The name saved in the Profile tab on this device, or "". */
export const useProfileName = () =>
  useLiveQuery(async () => ((await db.meta.get("profile"))?.value as { name?: string } | undefined)?.name?.trim() ?? "", [], "");
