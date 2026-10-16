// Exercises that the free catalogue is missing. They are merged into the catalogue when it is built
// (npm run seed).
import { tiktokUrl } from "./muscles";
import type { Exercise } from "./exercises";

const make = (e: Omit<Exercise, "tiktok_url" | "category" | "level"> & Partial<Pick<Exercise, "category" | "level">>): Exercise => ({
  category: "strength",
  level: "beginner",
  ...e,
  tiktok_url: tiktokUrl(e.name),
});

export const EXTRA_EXERCISES: Exercise[] = [
  make({
    id: "extra-lever-hip-thrust",
    name: "Lever Hip Thrust",
    muscle_groups: ["Glutes"],
    secondary_groups: ["Hamstrings", "Quads"],
    equipment: "Machine/Cable",
    mechanic: "compound",
    force: "push",
    instructions: [
      "Sit on the floor with your upper back resting against the back pad and your feet flat on the floor, about hip-width apart.",
      "Bring the lever's hip pad across your hips and hold the handles. Brace your core and tuck your chin slightly.",
      "Drive through your heels and push your hips up until your torso and thighs form a straight line and your shins are vertical.",
      "Squeeze your glutes hard for a second at the top.",
      "Lower under control until your hips are just above the floor, then repeat.",
    ],
    image_urls: [],
  }),
];
