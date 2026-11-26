import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { jsonFileStorage } from '@/lib/storage';

/**
 * A skill: instructions for a kind of task, kept as a folder with a SKILL.md and any files it
 * needs (lib/skills holds the files; this store keeps what lists and prompts need without reading them).
 */
export interface Skill {
  /** Unique; also the name of its folder. */
  name: string;
  /** What it does and when to use it, from its SKILL.md. Models pick skills by this. */
  description: string;
  /** Whether models are offered it. */
  enabled: boolean;
  /** Who made it: the user here, an install, a model with a tool, or the after-reply review. */
  source: 'user' | 'installed' | 'model' | 'auto';
  /** Where it was installed from. */
  origin?: string;
  /** Its other files, as paths relative to its folder. */
  files: string[];
  createdAt: number;
  updatedAt: number;
  /** Who changed it last, when a model has improved it since it was made. */
  updatedBy?: Skill['source'];
  /** The chat it was made or last changed in, by a model. */
  conversationId?: string;
}

interface SkillsState {
  skills: Record<string, Skill>;
  put: (skill: Skill) => void;
  patch: (name: string, patch: Partial<Skill>) => void;
  remove: (name: string) => void;
  setEnabled: (name: string, enabled: boolean) => void;
}

export const useSkills = create<SkillsState>()(
  persist(
    (set, get) => ({
      skills: {},
      put: (skill) => set({ skills: { ...get().skills, [skill.name]: skill } }),
      patch: (name, patch) => {
        const skill = get().skills[name];
        if (skill) set({ skills: { ...get().skills, [name]: { ...skill, ...patch } } });
      },
      remove: (name) => {
        const { [name]: _, ...rest } = get().skills;
        set({ skills: rest });
      },
      setEnabled: (name, enabled) => get().patch(name, { enabled }),
    }),
    { name: 'skills', storage: jsonFileStorage, partialize: (s) => ({ skills: s.skills }) }
  )
);

/** A skill as a chat's system prompt lists it. */
export type SkillRef = { name: string; description: string };

/** The skills models are offered, by name. */
export function enabledSkills(skills = useSkills.getState().skills): SkillRef[] {
  return Object.values(skills)
    .filter((s) => s.enabled)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, description }) => ({ name, description }));
}
