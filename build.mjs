#!/usr/bin/env node
/**
 * @fileoverview Build script for root functions (framework package)
 * @description Bundles @donotdev/core and creates framework functions package
 */

import { build } from 'esbuild';
import { createRootFunctionsConfig } from '@donotdev/core/functions';

async function buildFunctions() {
  console.log('🔨 Building root functions (framework package)...');
  
  try {
    console.log('📦 Bundling framework functions (JS only)...');
    
    const config = createRootFunctionsConfig({
      entry: 'src/firebase/index.ts',
      outDir: 'lib',
      minify: process.env.NODE_ENV === 'production',
      sourcemap: true,
    });
    
    const result = await build(config);
    
    if (result.errors.length > 0) {
      console.error('❌ Build errors:', result.errors);
      process.exit(1);
    }
    
    if (result.warnings.length > 0) {
      console.warn('⚠️ Build warnings:', result.warnings);
    }
    
    console.log('✅ Root functions built successfully!');
    console.log('📁 Output directory: lib/');
    
    // Log bundle info if metafile is available
    if (result.metafile) {
      const { analyzeMetafile } = await import('esbuild');
      const analysis = await analyzeMetafile(result.metafile);
      console.log('\n📊 Bundle analysis:');
      console.log(analysis);
    }
    
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

// Run the build
buildFunctions();
