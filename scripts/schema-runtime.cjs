const fs = require('fs');
const path = require('path');

const SCHEMA_FILES = {
  recon: 'recon.schema.json',
  findings: 'findings.schema.json',
  skeptic: 'skeptic.schema.json',
  referee: 'referee.schema.json',
  coverage: 'coverage.schema.json',
  experiment: 'experiment.schema.json',
  'fix-report': 'fix-report.schema.json',
  'fix-plan': 'fix-plan.schema.json',
  'fix-strategy': 'fix-strategy.schema.json',
  shared: 'shared.schema.json'
};

const SCHEMA_CACHE = new Map();

function getSchemaDir() {
  return path.resolve(__dirname, '..', 'schemas');
}

function getKnownArtifacts() {
  return Object.keys(SCHEMA_FILES).filter((name) => name !== 'shared');
}

function getSchemaPath(artifactName) {
  const fileName = SCHEMA_FILES[artifactName];
  if (!fileName) {
    throw new Error(`Unknown artifact schema: ${artifactName}`);
  }
  return path.join(getSchemaDir(), fileName);
}

function loadArtifactSchema(artifactName) {
  if (!SCHEMA_FILES[artifactName]) {
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

function describeType(value) {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

function resolveRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported schema ref: ${ref}`);
  }
  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = rootSchema;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      throw new Error(`Unable to resolve schema ref: ${ref}`);
    }
    current = current[part];
  }
  return current;
}

function validateAgainstSchema({ value, schema, rootSchema, jsonPath, errors }) {
  if (schema.$ref) {
    const resolved = resolveRef(rootSchema, schema.$ref);
    validateAgainstSchema({ value, schema: resolved, rootSchema, jsonPath, errors });
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${jsonPath} must equal ${JSON.stringify(schema.const)}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${jsonPath} must be one of: ${schema.enum.join(', ')}`);
    return;
  }

  if (schema.type === 'object') {
    if (describeType(value) !== 'object') {
      errors.push(`${jsonPath} must be an object`);
      return;
    }
    const properties = schema.properties || {};
    const required = schema.required || [];
    for (const propertyName of required) {
      if (!(propertyName in value)) {
        errors.push(`${jsonPath}.${propertyName} is required`);
      }
    }
    for (const [propertyName, propertyValue] of Object.entries(value)) {
      if (properties[propertyName]) {
        validateAgainstSchema({
          value: propertyValue,
          schema: properties[propertyName],
          rootSchema,
          jsonPath: `${jsonPath}.${propertyName}`,
          errors
        });
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${jsonPath}.${propertyName} is not allowed`);
      }
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${jsonPath} must be an array`);
      return;
    }
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${jsonPath} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateAgainstSchema({
          value: item,
          schema: schema.items,
          rootSchema,
          jsonPath: `${jsonPath}[${index}]`,
          errors
        });
      });
    }
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${jsonPath} must be a string`);
      return;
    }
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${jsonPath} must not be empty`);
    }
    if (schema.pattern) {
      const matcher = new RegExp(schema.pattern);
      if (!matcher.test(value)) {
        errors.push(`${jsonPath} must match ${schema.pattern}`);
      }
    }
    return;
  }

  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${jsonPath} must be a number`);
      return;
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${jsonPath} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${jsonPath} must be <= ${schema.maximum}`);
    }
    return;
  }

  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) {
      errors.push(`${jsonPath} must be an integer`);
      return;
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${jsonPath} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${jsonPath} must be <= ${schema.maximum}`);
    }
    return;
  }

  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${jsonPath} must be a boolean`);
  }
}

function validateArtifactValue({ artifactName, value }) {
  const { schema, schemaPath } = loadArtifactSchema(artifactName);
  const errors = [];
  validateAgainstSchema({
    value,
    schema,
    rootSchema: schema,
    jsonPath: '$',
    errors
  });
  return {
    ok: errors.length === 0,
    artifact: artifactName,
    schemaVersion: schema.schemaVersion,
    schemaFile: path.relative(path.resolve(__dirname, '..'), schemaPath),
    errors
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
