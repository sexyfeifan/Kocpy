/**
 * Astryx UI Entry Point
 *
 * This file replaces the original App.tsx as the renderer entry.
 * To switch back to the original UI, change main.tsx to import from '../App'.
 */
import '../index.css'
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import '@astryxdesign/theme-neutral/theme.css'
import './styles/astryx-overrides.css'

import { createRoot } from 'react-dom/client'
import { AstryxApp } from './App'

createRoot(document.getElementById('root')!).render(<AstryxApp />)
