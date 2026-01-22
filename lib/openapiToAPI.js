#!/usr/bin/env node

/**
 * OpenAPI to APIs.json Converter
 *
 * This script fetches the Paystack OpenAPI specification and converts it
 * to the APIs.json format used by the CLI commands.
 *
 * Usage: node lib/openapiToAPI.js
 *
 * The script will:
 * 1. Fetch the OpenAPI spec from GitHub (with local fallback)
 * 2. Parse and dereference $ref pointers
 * 3. Transform to the current APIs.json format
 * 4. Output to src/lib/paystack/APIs.json
 */

const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const $RefParser = require('@apidevtools/json-schema-ref-parser')

// URLs and paths
const OPENAPI_URL = 'https://raw.githubusercontent.com/PaystackOSS/openapi/refs/heads/main/dist/paystack.yaml'
const LOCAL_SPEC_PATH = path.join(__dirname, 'paystack.yaml')
const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'lib', 'paystack', 'APIs.json')

/**
 * Fetch OpenAPI spec from URL with local fallback
 */
async function fetchOpenAPISpec() {
  try {
    console.log(`Fetching OpenAPI spec from ${OPENAPI_URL}...`)
    const response = await fetch(OPENAPI_URL)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    const yamlText = await response.text()
    console.log('Successfully fetched OpenAPI spec from remote.')
    return YAML.parse(yamlText)
  } catch (error) {
    console.log(`Failed to fetch from remote: ${error.message}`)
    console.log(`Falling back to local file: ${LOCAL_SPEC_PATH}`)

    if (!fs.existsSync(LOCAL_SPEC_PATH)) {
      throw new Error(`Local OpenAPI spec not found at ${LOCAL_SPEC_PATH}`)
    }

    const yamlText = fs.readFileSync(LOCAL_SPEC_PATH, 'utf-8')
    console.log('Successfully loaded OpenAPI spec from local file.')
    return YAML.parse(yamlText)
  }
}

/**
 * Parse operationId to extract parent and api name
 * e.g., "transaction_initialize" -> { parent: "transaction", api: "initialize" }
 * e.g., "dedicated_account_create" -> { parent: "dedicatedaccount", api: "create" }
 */
function parseOperationId(operationId, tag) {
  if (!operationId) {
    return { parent: normalizeParent(tag || 'misc'), api: 'unknown' }
  }

  const parts = operationId.split('_')
  if (parts.length === 1) {
    return { parent: normalizeParent(tag || parts[0]), api: parts[0] }
  }

  // The api name is typically the last part
  const api = parts[parts.length - 1]

  // The parent is everything before the api, joined without underscores
  const parentParts = parts.slice(0, -1)
  const parent = normalizeParent(parentParts.join(''))

  return { parent, api }
}

/**
 * Normalize parent name (lowercase, no spaces/special chars)
 */
function normalizeParent(name) {
  return name.toLowerCase().replace(/[\s-]/g, '')
}

/**
 * Convert OpenAPI path format {param} to CLI format :param
 */
function convertPath(openApiPath) {
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1')
}

/**
 * Extract path variables from OpenAPI parameters
 */
function extractPathVariables(parameters) {
  if (!parameters) return []

  return parameters
    .filter(param => param.in === 'path')
    .map(param => ({
      key: param.name,
      value: param.example || '',
      description: `(Required) ${param.description || ''}`
    }))
}

/**
 * Extract query parameters from OpenAPI parameters
 */
function extractQueryParams(parameters) {
  if (!parameters) return []

  return parameters
    .filter(param => param.in === 'query')
    .map(param => ({
      parameter: param.name,
      description: param.description || '',
      required: param.required || false
    }))
}

/**
 * Extract body parameters from request body schema
 */
function extractBodyParams(requestBody, spec) {
  if (!requestBody || !requestBody.content) return []

  const content = requestBody.content['application/json'] ||
                  requestBody.content['application/x-www-form-urlencoded']

  if (!content || !content.schema) return []

  let schema = content.schema

  // Resolve $ref if present
  if (schema.$ref) {
    const refPath = schema.$ref.replace('#/', '').split('/')
    schema = refPath.reduce((obj, key) => obj && obj[key], spec)
    if (!schema) return []
  }

  if (!schema.properties) return []

  const requiredFields = schema.required || []

  return Object.entries(schema.properties).map(([name, prop]) => {
    let description = prop.description || ''

    // Resolve $ref in property if present
    if (prop.$ref) {
      const refPath = prop.$ref.replace('#/', '').split('/')
      const refSchema = refPath.reduce((obj, key) => obj && obj[key], spec)
      if (refSchema) {
        description = refSchema.description || description
      }
    }

    const isRequired = requiredFields.includes(name)
    if (isRequired && !description.toLowerCase().startsWith('(required)')) {
      description = `(Required) ${description}`
    }

    return {
      parameter: name,
      description: description,
      required: isRequired
    }
  })
}

/**
 * Transform OpenAPI spec to APIs.json format
 */
function transformToAPIsJson(spec) {
  const apis = {}
  const baseUrl = spec.servers && spec.servers[0] ? spec.servers[0].url + '/' : 'https://api.paystack.co/'

  for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      // Skip non-HTTP method properties
      if (['parameters', 'servers', 'summary', 'description', '$ref'].includes(method)) {
        continue
      }

      const tag = operation.tags && operation.tags[0] ? operation.tags[0] : 'Miscellaneous'
      const { parent: defaultParent, api: defaultApi } = parseOperationId(operation.operationId, tag)

      // Check for special mappings (miscellaneous endpoints with dedicated CLI commands)
      const { parent, api } = getSpecialMapping(operation.operationId, defaultParent, defaultApi)

      // Convert path format
      const cliPath = convertPath(pathKey).replace(/^\//, '') // Remove leading slash

      // Extract parameters
      const pathVariables = extractPathVariables(operation.parameters)
      const queryParams = extractQueryParams(operation.parameters)
      const bodyParams = extractBodyParams(operation.requestBody, spec)

      // Combine query and body params
      const allParams = [...queryParams, ...bodyParams]

      // Build API entry
      const apiEntry = {
        baseUrl: baseUrl,
        path: cliPath,
        method: method.toUpperCase(),
        params: allParams,
        api: api,
        parent: parent
      }

      // Add variables only if there are path variables
      if (pathVariables.length > 0) {
        apiEntry.variables = pathVariables
      }

      // Initialize parent array if needed
      if (!apis[parent]) {
        apis[parent] = []
      }

      apis[parent].push(apiEntry)
    }
  }

  return apis
}

/**
 * Mapping for miscellaneous endpoints that have their own CLI commands
 * These endpoints are grouped under 'Miscellaneous' in OpenAPI but have
 * dedicated command files in the CLI
 *
 * Format: { operationId: { parent: 'cliCommandName', api: 'endpointName' } }
 */
const MISCELLANEOUS_MAPPINGS = {
  'miscellaneous_avs': { parent: 'avs', api: 'list' },
  'miscellaneous_resolveCardBin': { parent: 'card', api: 'resolve' },
  'miscellaneous_listCountries': { parent: 'country', api: 'list' }
}

/**
 * Mapping for other endpoints that need special handling
 */
const SPECIAL_MAPPINGS = {
  // settlement command uses singular, OpenAPI uses plural
  'settlements': 'settlement',
  // paymentsessiontimeout has its own command but lives under integration
  'integration_fetchPaymentSessionTimeout': { parent: 'paymentsessiontimeout', api: 'fetch' },
  'integration_updatePaymentSessionTimeout': { parent: 'paymentsessiontimeout', api: 'update' }
}

/**
 * Check if an operationId should be mapped to a different parent/api
 */
function getSpecialMapping(operationId, defaultParent, defaultApi) {
  // Check miscellaneous mappings
  if (MISCELLANEOUS_MAPPINGS[operationId]) {
    return MISCELLANEOUS_MAPPINGS[operationId]
  }

  // Check other special mappings
  const specialKey = `${defaultParent}_${defaultApi}`
  if (SPECIAL_MAPPINGS[specialKey]) {
    return SPECIAL_MAPPINGS[specialKey]
  }

  // Check if parent needs renaming (e.g., settlements -> settlement)
  if (SPECIAL_MAPPINGS[defaultParent]) {
    return { parent: SPECIAL_MAPPINGS[defaultParent], api: defaultApi }
  }

  return { parent: defaultParent, api: defaultApi }
}

/**
 * Sort APIs for consistent output
 */
function sortAPIs(apis) {
  const sorted = {}

  // Sort parents alphabetically
  const sortedParents = Object.keys(apis).sort()

  for (const parent of sortedParents) {
    // Sort APIs within each parent by api name
    sorted[parent] = apis[parent].sort((a, b) => a.api.localeCompare(b.api))
  }

  return sorted
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('Starting OpenAPI to APIs.json conversion...\n')

    // Fetch and parse OpenAPI spec
    const spec = await fetchOpenAPISpec()

    // Dereference $ref pointers for easier processing
    console.log('Dereferencing $ref pointers...')
    const dereferencedSpec = await $RefParser.dereference(spec)
    console.log('Successfully dereferenced spec.\n')

    // Transform to APIs.json format
    console.log('Transforming to APIs.json format...')
    const apis = transformToAPIsJson(dereferencedSpec)

    // Sort for consistent output
    const sortedApis = sortAPIs(apis)

    // Write output
    console.log(`Writing output to ${OUTPUT_PATH}...`)
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(sortedApis, null, 4))

    // Print summary
    const parentCount = Object.keys(sortedApis).length
    const apiCount = Object.values(sortedApis).reduce((sum, arr) => sum + arr.length, 0)
    console.log(`\nDone! Generated ${apiCount} API endpoints across ${parentCount} resources.`)

    // List resources
    console.log('\nResources:')
    for (const [parent, endpoints] of Object.entries(sortedApis)) {
      console.log(`  - ${parent}: ${endpoints.length} endpoints`)
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

// Run if called directly
if (require.main === module) {
  main()
}

module.exports = { transformToAPIsJson, parseOperationId, extractBodyParams }
