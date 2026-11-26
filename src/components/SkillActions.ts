import { router } from 'expo-router';
import type { Skill } from '@/store/skills';
import { choose } from './Dialogs';

export const SKILL_SOURCES: Record<Skill['source'], string> = {
  user: 'Written by you',
  installed: 'Installed',
  model: 'Saved by a model',
  auto: 'Learned automatically',
};

export const SKILL_ICONS: Record<Skill['source'], 'edit-3' | 'download' | 'cpu' | 'zap'> = {
  user: 'edit-3',
  installed: 'download',
  model: 'cpu',
  auto: 'zap',
};

/** Asks how to add a skill: install one, or write one. */
export function addSkill() {
  choose({
    title: 'Add a skill',
    choices: [
      {
        label: 'Install',
        icon: { feather: 'download' },
        detail: 'From GitHub, a link, or a .zip, .skill or SKILL.md file',
        onPress: () => router.push('/skills/install'),
      },
      {
        label: 'Write a skill',
        icon: { feather: 'edit-3' },
        detail: 'Describe a task and how to do it',
        onPress: () => router.push('/skills/edit'),
      },
    ],
  });
}
