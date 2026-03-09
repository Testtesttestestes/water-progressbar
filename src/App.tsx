/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { RealisticProgressBar } from './components/RealisticProgressBar';

export default function App() {
  const [progress, setProgress] = useState(0.5);
  const [isWaving, setIsWaving] = useState(false);

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-2xl space-y-12">
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-medium text-gray-900 tracking-tight">Realistic Water Shader</h1>
          <p className="text-gray-500">WebGL SDF Rendering</p>
        </div>

        <RealisticProgressBar progress={progress} isWaving={isWaving} />

        <div className="space-y-4 max-w-md mx-auto">
          <div className="flex justify-between text-sm font-medium text-gray-500">
            <span>0%</span>
            <span>{Math.round(progress * 100)}%</span>
            <span>100%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={progress}
            onChange={(e) => setProgress(parseFloat(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
          />
          <div className="flex justify-center pt-4">
            <button
              onClick={() => setIsWaving(!isWaving)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                isWaving 
                  ? 'bg-blue-500 text-white hover:bg-blue-600' 
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {isWaving ? 'Stop Waves' : 'Generate Waves'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
