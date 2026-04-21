import { create } from 'zustand';
import { storage } from '@/services/storage.service';

export type Density = 'comfortable' | 'compact';

const STORAGE_KEY = 'density';

interface State {
  density: Density;
  setDensity: (d: Density) => void;
  toggle: () => void;
}

function readInitial(): Density {
  const stored = storage.get<Density>(STORAGE_KEY);
  return stored === 'compact' ? 'compact' : 'comfortable';
}

export const useDensityStore = create<State>((set, get) => ({
  density: readInitial(),
  setDensity: (d) => { storage.set(STORAGE_KEY, d); set({ density: d }); },
  toggle: () => {
    const next: Density = get().density === 'comfortable' ? 'compact' : 'comfortable';
    storage.set(STORAGE_KEY, next);
    set({ density: next });
  },
}));
