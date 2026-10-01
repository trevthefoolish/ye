// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// The pipeline config.render.pipeline names, built from the render config.

const { PIPELINE_SECTION, PIPELINE_VERSE } = require('../config');
const { createPassagePipeline } = require('./passage-v1');
const { createSectionPipeline } = require('./section-v2');
const { createVersePipeline } = require('./verse-v1');

function createPipeline(render, log) {
  if (render.pipeline === PIPELINE_SECTION) return createSectionPipeline(render);
  if (render.pipeline === PIPELINE_VERSE) return createVersePipeline({ ...render, log });
  return createPassagePipeline(render);
}

module.exports = { createPipeline };
