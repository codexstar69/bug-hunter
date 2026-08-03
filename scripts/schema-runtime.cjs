const fs = require('fs');
const path = require('path');
const generatedValidators = require('./generated-schema-validators.cjs');
const { SCHEMA_FILES, VALIDATOR_EXPORTS } = require('./schema-catalog.cjs');

const SCHEMA_CACHE = new Map();

function getSchemaDir() {
  return path.resolve(__dirname, '..', 'schemas');
}

function getKnownArtifacts() {
  return Object.keys(VALIDATOR_EXPORTS);
}

function getSchemaPath(artifactName) {
  const fileName = SCHEMA_FILES[artifactName];
  if (!fileName || !VALIDATOR_EXPORTS[artifactName]) {
    throw new Error(`Unknown artifact schema: ${artifactName}`);
  }
  return path.join(getSchemaDir(), fileName);
}

function loadArtifactSchema(artifactName) {
  if (!VALIDATOR_EXPORTS[artifactName]) {
    throw new Error(`Unknown artifact schema: ${artifactName}`);
  }
  if (!SCHEMA_CACHE.has(artifactName)) {
    const schemaPath = getSchemaPath(artifactName);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    if (!Number.isInteger(schema.schemaVersion) || schema.schemaVersion <= 0) {
      throw new Error(`Schema ${artifactName} is missing a valid schemaVersion`);
    }
    SCHEMA_CACHE.set(artifactName, { schema, schemaPath });
  }
  return SCHEMA_CACHE.get(artifactName);
}

function createSchemaRef(artifactName) {
  const { schema, schemaPath } = loadArtifactSchema(artifactName);
  return {
    artifact: artifactName,
    schemaVersion: schema.schemaVersion,
    schemaFile: path.relative(path.resolve(__dirname, '..'), schemaPath)
  };
}

function validateSchemaRef(reference) {
  const errors = [];
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    return { ok: false, errors: ['outputSchema must be an object'] };
  }

  const artifactName = String(reference.artifact || '').trim();
  if (!artifactName) {
    errors.push('outputSchema.artifact must be a non-empty string');
  } else if (!getKnownArtifacts().includes(artifactName)) {
    errors.push(`outputSchema.artifact must be one of: ${getKnownArtifacts().join(', ')}`);
  }

  if (!Number.isInteger(reference.schemaVersion) || reference.schemaVersion <= 0) {
    errors.push('outputSchema.schemaVersion must be a positive integer');
  }

  if (artifactName && getKnownArtifacts().includes(artifactName)) {
    const { schema, schemaPath } = loadArtifactSchema(artifactName);
    const expectedRelativePath = path.relative(path.resolve(__dirname, '..'), schemaPath);
    if (reference.schemaVersion !== schema.schemaVersion) {
      errors.push(`outputSchema.schemaVersion must match ${artifactName} schema version ${schema.schemaVersion}`);
    }
    if ('schemaFile' in reference && reference.schemaFile !== expectedRelativePath) {
      errors.push(`outputSchema.schemaFile must match ${expectedRelativePath}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function jsonPathFromInstancePath(instancePath) {
  return String(instancePath || '').split('/').slice(1).reduce((jsonPath, rawPart) => {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~');
    if (/^\d+$/.test(part)) {
      return `${jsonPath}[${part}]`;
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) {
      return `${jsonPath}.${part}`;
    }
    return `${jsonPath}[${JSON.stringify(part)}]`;
  }, '$');
}

function formatValidationError(error) {
  const jsonPath = jsonPathFromInstancePath(error.instancePath);
  if (error.keyword === 'required' && error.params?.missingProperty) {
    return `${jsonPath}.${error.params.missingProperty} is required`;
  }
  if (error.keyword === 'additionalProperties' && error.params?.additionalProperty) {
    return `${jsonPath}.${error.params.additionalProperty} is not allowed`;
  }
  const suffix = error.message ? ` ${error.message}` : ' is invalid';
  return `${jsonPath}${suffix}`;
}

function validateArtifactValue({ artifactName, value }) {
  const { schema, schemaPath } = loadArtifactSchema(artifactName);
  const validatorName = VALIDATOR_EXPORTS[artifactName];
  const validate = generatedValidators[validatorName];
  if (typeof validate !== 'function') {
    throw new Error(`Generated validator is missing for artifact: ${artifactName}`);
  }
  const ok = validate(value);
  return {
    ok,
    artifact: artifactName,
    schemaVersion: schema.schemaVersion,
    schemaFile: path.relative(path.resolve(__dirname, '..'), schemaPath),
    errors: ok ? [] : (validate.errors || []).map(formatValidationError)
  };
}

function validateArtifactFile({ artifactName, filePath }) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return validateArtifactValue({ artifactName, value });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, artifact: artifactName, errors: [message] };
  }
}

module.exports = {
  createSchemaRef,
  getKnownArtifacts,
  getSchemaPath,
  loadArtifactSchema,
  validateArtifactFile,
  validateArtifactValue,
  validateSchemaRef
};
