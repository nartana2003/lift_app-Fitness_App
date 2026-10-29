// The Lift Evidence Library: a short, fixed set of research the Coach may cite.
// The rules and the AI routes cite entries by id and never invent a source.
// Every entry below was checked against its PubMed record (title, authors,
// journal, year, DOI). Claims paraphrase the abstract and keep its limits (who was
// studied, how many studies). General fitness information, not medical advice.
// Pure data and lookups: no I/O, no React, no AI.
import type { MuscleGroup } from "../muscles";

export const EVIDENCE_TOPICS = [
  "volume",
  "frequency",
  "load",
  "failure",
  "rest",
  "prescription",
  "muscle_length",
] as const;
export type EvidenceTopic = (typeof EVIDENCE_TOPICS)[number];

/** How strong the source is: pooled studies, one trial, a narrative review, or an expert position stand. */
export const EVIDENCE_DESIGNS = ["meta-analysis", "trial", "review", "position-stand"] as const;
export type EvidenceDesign = (typeof EVIDENCE_DESIGNS)[number];

export type EvidenceSource = {
  title: string;
  authors: string;
  journal: string;
  year: number;
  pmid: string;
  doi: string;
  /** The PubMed page for the paper. */
  url: string;
};

export type EvidenceEntry = {
  id: string;
  design: EvidenceDesign;
  /** People in the study, for a single trial. */
  participants?: number;
  topic: EvidenceTopic;
  /** Set when the finding is about particular muscles; absent when it applies to training in general. */
  muscles?: MuscleGroup[];
  /** Catalogue exercise ids the finding is about. */
  exerciseIds?: string[];
  /** One or two plain sentences. */
  claim: string;
  source: EvidenceSource;
};

const source = (s: Omit<EvidenceSource, "url">): EvidenceSource => ({ ...s, url: `https://pubmed.ncbi.nlm.nih.gov/${s.pmid}/` });

export const EVIDENCE_LIBRARY: readonly EvidenceEntry[] = [
  {
    id: "volume-hypertrophy",
    design: "meta-analysis",
    topic: "volume",
    claim: "Across 15 studies, doing more sets per muscle each week went with more muscle growth, in a graded way.",
    source: source({
      title: "Dose-response relationship between weekly resistance training volume and increases in muscle mass: A systematic review and meta-analysis",
      authors: "Schoenfeld BJ, Ogborn D, Krieger JW",
      journal: "Journal of Sports Sciences",
      year: 2017,
      pmid: "27433992",
      doi: "10.1080/02640414.2016.1210197",
    }),
  },
  {
    id: "volume-strength",
    design: "meta-analysis",
    topic: "volume",
    claim: "Across 9 studies, more weekly sets per exercise gave more strength. For novice and intermediate men, low weekly volumes fell short of medium and high volumes.",
    source: source({
      title: "The Effect of Weekly Set Volume on Strength Gain: A Meta-Analysis",
      authors: "Ralston GW, Kilgore L, Wyatt FB, Baker JS",
      journal: "Sports Medicine",
      year: 2017,
      pmid: "28755103",
      doi: "10.1007/s40279-017-0762-7",
    }),
  },
  {
    id: "volume-multiple-sets",
    design: "meta-analysis",
    topic: "volume",
    claim: "Across 8 studies, several sets of an exercise grew more muscle than a single set.",
    source: source({
      title: "Single vs. multiple sets of resistance exercise for muscle hypertrophy: a meta-analysis",
      authors: "Krieger JW",
      journal: "Journal of Strength and Conditioning Research",
      year: 2010,
      pmid: "20300012",
      doi: "10.1519/JSC.0b013e3181d4d436",
    }),
  },
  {
    id: "frequency-twice-weekly",
    design: "meta-analysis",
    topic: "frequency",
    claim: "Across 10 studies, training a muscle twice a week grew more muscle than once a week when volume was matched. There was too little data to say whether three times beats twice.",
    source: source({
      title: "Effects of Resistance Training Frequency on Measures of Muscle Hypertrophy: A Systematic Review and Meta-Analysis",
      authors: "Schoenfeld BJ, Ogborn D, Krieger JW",
      journal: "Sports Medicine",
      year: 2016,
      pmid: "27102172",
      doi: "10.1007/s40279-016-0543-8",
    }),
  },
  {
    id: "frequency-volume-equated",
    design: "meta-analysis",
    topic: "frequency",
    claim: "When total weekly volume was matched, training a muscle more often gave no meaningful extra growth. Studies that did not match volume showed a small edge for higher frequency.",
    source: source({
      title: "How many times per week should a muscle be trained to maximize muscle hypertrophy? A systematic review and meta-analysis of studies examining the effects of resistance training frequency",
      authors: "Schoenfeld BJ, Grgic J, Krieger J",
      journal: "Journal of Sports Sciences",
      year: 2019,
      pmid: "30558493",
      doi: "10.1080/02640414.2018.1555906",
    }),
  },
  {
    id: "frequency-strength",
    design: "meta-analysis",
    topic: "frequency",
    claim: "Across 22 studies, more training days per week went with more strength, but with equal volume frequency made no significant difference. Volume looks like the main driver.",
    source: source({
      title: "Effect of Resistance Training Frequency on Gains in Muscular Strength: A Systematic Review and Meta-Analysis",
      authors: "Grgic J, Schoenfeld BJ, Davies TB, Lazinica B, Krieger JW, Pedisic Z",
      journal: "Sports Medicine",
      year: 2018,
      pmid: "29470825",
      doi: "10.1007/s40279-018-0872-x",
    }),
  },
  {
    id: "load-range",
    design: "meta-analysis",
    topic: "load",
    claim: "Across 21 studies, heavy loads gave bigger gains in one-rep-max strength. Muscle growth was similar across a wide range of loads.",
    source: source({
      title: "Strength and Hypertrophy Adaptations Between Low- vs. High-Load Resistance Training: A Systematic Review and Meta-analysis",
      authors: "Schoenfeld BJ, Grgic J, Ogborn D, Krieger JW",
      journal: "Journal of Strength and Conditioning Research",
      year: 2017,
      pmid: "28834797",
      doi: "10.1519/JSC.0000000000002200",
    }),
  },
  {
    id: "failure-proximity",
    design: "meta-analysis",
    topic: "failure",
    claim: "Across 15 studies, training to failure gave at most a trivial growth edge over stopping short of it, and no edge for going to momentary failure specifically.",
    source: source({
      title: "Influence of Resistance Training Proximity-to-Failure on Skeletal Muscle Hypertrophy: A Systematic Review with Meta-analysis",
      authors: "Refalo MC, Helms ER, Trexler ET, Hamilton DL, Fyfe JJ",
      journal: "Sports Medicine",
      year: 2023,
      pmid: "36334240",
      doi: "10.1007/s40279-022-01784-y",
    }),
  },
  {
    id: "rest-three-minutes",
    design: "trial",
    participants: 21,
    topic: "rest",
    claim: "In 21 experienced young men over 8 weeks, resting 3 minutes between sets gave more strength and thigh muscle thickness than resting 1 minute.",
    source: source({
      title: "Longer Interset Rest Periods Enhance Muscle Strength and Hypertrophy in Resistance-Trained Men",
      authors: "Schoenfeld BJ, Pope ZK, Benik FM, Hester GM, Sellers J, Nooner JL, Schnaiter JA, Bond-Williams KE, Carter AS, Ross CL, Just BL, Henselmans M, Krieger JW",
      journal: "Journal of Strength and Conditioning Research",
      year: 2016,
      pmid: "26605807",
      doi: "10.1519/JSC.0000000000001272",
    }),
  },
  {
    id: "rest-review",
    design: "review",
    topic: "rest",
    claim: "No long-term study found more growth with shorter rests between sets, so building muscle does not need shorter rests than building strength.",
    source: source({
      title: "The effect of inter-set rest intervals on resistance exercise-induced muscle hypertrophy",
      authors: "Henselmans M, Schoenfeld BJ",
      journal: "Sports Medicine",
      year: 2014,
      pmid: "25047853",
      doi: "10.1007/s40279-014-0228-0",
    }),
  },
  {
    id: "prescription-network",
    design: "meta-analysis",
    topic: "prescription",
    claim: "Every resistance training prescription improved strength and muscle size compared with none. Loads above 80% of one-rep max gave the biggest strength gains, and the top prescriptions for growth used multiple sets per session.",
    source: source({
      title: "Resistance training prescription for muscle strength and hypertrophy in healthy adults: a systematic review and Bayesian network meta-analysis",
      authors: "Currier BS, Mcleod JC, Banfield L, Beyene J, Welton NJ, D'Souza AC, Keogh JAJ, Lin L, Coletta G, Yang A, Colenso-Semple L, Lau KJ, Verboom A, Phillips SM",
      journal: "British Journal of Sports Medicine",
      year: 2023,
      pmid: "37414459",
      doi: "10.1136/bjsports-2023-106807",
    }),
  },
  {
    id: "prescription-acsm",
    design: "position-stand",
    topic: "prescription",
    claim: "The American College of Sports Medicine advises lower-volume, lower-frequency programs for novices and periodized, heavier loading for intermediate and advanced trainees.",
    source: source({
      title: "American College of Sports Medicine position stand. Progression models in resistance training for healthy adults",
      authors: "American College of Sports Medicine",
      journal: "Medicine & Science in Sports & Exercise",
      year: 2009,
      pmid: "19204579",
      doi: "10.1249/MSS.0b013e3181915670",
    }),
  },
  {
    id: "hamstrings-seated-curl",
    design: "trial",
    participants: 20,
    topic: "muscle_length",
    muscles: ["Hamstrings"],
    exerciseIds: ["Seated_Leg_Curl"],
    claim: "In a 12-week study of 20 adults, seated leg curls, which train the hamstrings stretched, grew them more than prone leg curls.",
    source: source({
      title: "Greater Hamstrings Muscle Hypertrophy but Similar Damage Protection after Training at Long versus Short Muscle Lengths",
      authors: "Maeo S, Huang M, Wu Y, Sakurai H, Kusagawa Y, Sugiyama T, Kanehisa H, Isaka T",
      journal: "Medicine & Science in Sports & Exercise",
      year: 2021,
      pmid: "33009197",
      doi: "10.1249/MSS.0000000000002523",
    }),
  },
  {
    id: "triceps-overhead",
    design: "trial",
    participants: 21,
    topic: "muscle_length",
    muscles: ["Triceps"],
    exerciseIds: ["Cable_Rope_Overhead_Triceps_Extension", "Triceps_Overhead_Extension_with_Rope", "Standing_Overhead_Barbell_Triceps_Extension"],
    claim: "In 21 adults, elbow extensions with the arm overhead grew the triceps substantially more than with the arm at the side.",
    source: source({
      title: "Triceps brachii hypertrophy is substantially greater after elbow extension training performed in the overhead versus neutral arm position",
      authors: "Maeo S, Wu Y, Huang M, Sakurai H, Kusagawa Y, Sugiyama T, Kanehisa H, Isaka T",
      journal: "European Journal of Sport Science",
      year: 2023,
      pmid: "35819335",
      doi: "10.1080/17461391.2022.2100279",
    }),
  },
  {
    id: "quads-lengthened-range",
    design: "trial",
    participants: 45,
    topic: "muscle_length",
    muscles: ["Quads"],
    exerciseIds: ["Leg_Extensions"],
    claim: "In 45 untrained women, knee extensions through the longer-muscle part of the range grew some quadriceps regions more than other ranges did. Strength gains were similar.",
    source: source({
      title: "Partial range of motion training elicits favorable improvements in muscular adaptations when carried out at long muscle lengths",
      authors: "Pedrosa GF, Lima FV, Schoenfeld BJ, Lacerda LT, Simoes MG, Pereira MR, Diniz RCR, Chagas MH",
      journal: "European Journal of Sport Science",
      year: 2022,
      pmid: "33977835",
      doi: "10.1080/17461391.2021.1927199",
    }),
  },
  {
    id: "calves-lengthened-range",
    design: "trial",
    participants: 42,
    topic: "muscle_length",
    muscles: ["Calves"],
    claim: "In 42 young women over 8 weeks, calf raises through the lengthened (bottom) part of the range grew the inner calf muscle most.",
    source: source({
      title: "Greater Gastrocnemius Muscle Hypertrophy After Partial Range of Motion Training Performed at Long Muscle Lengths",
      authors: "Kassiano W, Costa B, Kunevaliki G, Soares D, Zacarias G, Manske I, Takaki Y, Ruggiero MF, Stavinski N, Francsuel J, Tricoli I, Carneiro MAS, Cyrino ES",
      journal: "Journal of Strength and Conditioning Research",
      year: 2023,
      pmid: "37015016",
      doi: "10.1519/JSC.0000000000004460",
    }),
  },
  {
    id: "glutes-thrust-squat",
    design: "trial",
    participants: 34,
    topic: "muscle_length",
    muscles: ["Glutes"],
    exerciseIds: ["Barbell_Hip_Thrust", "Barbell_Squat"],
    claim: "In untrained students over 9 weeks, hip thrusts and back squats grew the glutes by a similar amount. Squats grew the thigh muscles more.",
    source: source({
      title: "Hip thrust and back squat training elicit similar gluteus muscle hypertrophy and transfer similarly to the deadlift",
      authors: "Plotkin DL, Rodas MA, Vigotsky AD, Heinbockel R, Robitzsch A, Schoenfeld BJ, et al",
      journal: "Frontiers in Physiology",
      year: 2023,
      pmid: "37877099",
      doi: "10.3389/fphys.2023.1279170",
    }),
  },
];

/** Short strength label to show beside a claim, for example "Single trial, 21 people". */
export function evidenceStrength(e: Pick<EvidenceEntry, "design" | "participants">): string {
  if (e.design === "meta-analysis") return "Pooled analysis of several studies";
  if (e.design === "trial") return `Single trial${e.participants ? `, ${e.participants} people` : ""}`;
  if (e.design === "review") return "Review of studies";
  return "Expert position stand";
}

export type EvidenceQuery = { muscle?: MuscleGroup; exerciseId?: string; topic?: EvidenceTopic };

/**
 * Entries that match every filter given. A muscle or exercise filter only matches
 * entries about that muscle or exercise; use `topic` alone for general findings.
 * With no filter, every entry.
 */
export function evidenceFor(q: EvidenceQuery = {}): EvidenceEntry[] {
  return EVIDENCE_LIBRARY.filter(
    (e) =>
      (!q.muscle || !!e.muscles?.includes(q.muscle)) &&
      (!q.exerciseId || !!e.exerciseIds?.includes(q.exerciseId)) &&
      (!q.topic || e.topic === q.topic),
  );
}

/** One entry by id, or undefined. Ids from outside (a model, a saved change) must pass through here. */
export function evidenceById(id: string): EvidenceEntry | undefined {
  return EVIDENCE_LIBRARY.find((e) => e.id === id);
}

/** Keeps only ids that name a real entry, in order, without repeats. */
export function knownEvidenceIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => !!evidenceById(id));
}
