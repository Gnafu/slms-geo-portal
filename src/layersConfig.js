import { map as mapConfig, languages, layersConfigApi as api } from 'config'
import httpRequest from './httpRequest'
import auth from './auth'

export function getLocalizedLabels(labelObj, defaultText) {
  labelObj = labelObj || []
  const ret = []

  // Get the labels from the label object
  labelObj.forEach(l => {
    if (l.language) ret.push({ language: l.language, label: l.label || defaultText })
  })

  // Add the missing labels, based on the languages array
  languages.forEach(lang => {
    if (!ret.find(l => l.language === lang.id)) {
      ret.push({ language: lang.id, label: defaultText })
    }
  })
  return ret
}

export class Layer {
  constructor(layerConfig) {
    this.id = Layer.nextId++
    this.originalId = layerConfig.id
    this.type = layerConfig.type || 'wms'
    if (this.type === 'wms') {
      // Backwards compatibility - all layers will have the serverUrls attribute
      this.serverUrls = layerConfig.serverUrls || mapConfig.defaultGeoServerURLs
      // The urls attribute will be deleted when saving
      // this.urls = layerConfig.serverUrls ? layerConfig.serverUrls : (mapConfig.defaultGeoServerURLs || null)
      this.name = layerConfig.wmsName || layerConfig.name || null
      this.styles = getLocalizedLabels(layerConfig.styles)
      this.imageFormat = layerConfig.imageFormat || 'image/png8'
      this.legend = layerConfig.legend || null // TODO check structure

      const tTimes = layerConfig.times || []
      this.times = tTimes.map(time => ({
        iso8601: time,
        humanReadable: time // TODO - create a humanReadable function
      }))

      this.statistics = layerConfig.statistics && layerConfig.statistics.map(s => {
        const ret = {
          type: s.type,
          labels: s.labels
        }
        switch (s.type) {
          case 'url':
            ret.url = s.url
            break
          case 'attributes':
            ret.attributes = s.attributes && s.attributes.map(a => ({
              attribute: a.attribute,
              labels: a.labels || a.attribute
            }))
            break
          default:
            throw new Error(`Unsupported statistics type: ${s.type}`)
        }

        return ret
      })

      this.downloadLinks = layerConfig.downloadLinks
    }

    this.visible = !!layerConfig.visible !== false
    this.sourceLink = layerConfig.sourceLink || null
    this.sourceLabel = layerConfig.sourceLabel || null
  }

  static nextId = 0
}

class Item {
  constructor(conf) {
    this.id = Item.nextId++
    this.infoFile = conf.infoFile || null
    this.labels = getLocalizedLabels(conf.labels)
  }

  recReduce(fn, val) {
    return this.items.reduce((acc, item) => item.isGroup ? item.recReduce(fn, acc) : fn(acc, item), val)
  }

  findById(id) {
    if (this.id === id) return this
    return this.isGroup && this.items.reduce((found, item) => found || item.findById(id), null)
  }

  // findById_(id) {
  //   return this.recReduce((found, item) => found || (item.id === id) && item, null)
  // }

  get isGroup() {
    return !!this.items
  }

  static nextId = 0
}

export class Context extends Item {
  constructor(contextConfig, layers) {
    super(contextConfig)

    // Keeps track of the original id to be used in the Group constructor but creates a new one for internal use
    // The original id can be a String but we use an incremental unique id for contexts and groups
    this.originalId = contextConfig.id
    this.active = !!contextConfig.active

    const findLayerById = (arr, id) => arr.find(item => item.originalId === id)
    const tLayers = contextConfig.layers &&
                    contextConfig.layers.map(id => findLayerById(layers, id))
                                        .filter(layer => !!layer) // Silently remove nulls (unmatched layers)
    this.layers = tLayers || []
    this.inlineLegendUrl = contextConfig.inlineLegendUrl || null
  }

  get hasLegends() {
    // The context has a legend if any of his layers has one
    // i.e. if any of is layers has a legend attribute or a styles attribute with a not null label
    return this.layers.some(layer => layer.legend || layer.styles && layer.styles.some(s => s.label))
  }
}

export class Group extends Item {
  constructor(groupConfig, contexts, parent) {
    super(groupConfig)

    this.parent = parent
    this.exclusive = !!groupConfig.exclusive

    // Keep backwards compatibility (pre allowDisableAll)
    if (groupConfig.exclusive) {
      if (typeof groupConfig.allowDisableAll === 'undefined') this.allowDisableAll = true
      else this.allowDisableAll = !!groupConfig.allowDisableAll
    }

    this.items = (groupConfig.items || []).map(item => {
      if (typeof item.context !== 'undefined') { // item.context might be 0
        // Create a dummy context if not found in the contexts array
        const context = contexts.find(c => c.originalId === item.context) ||
                        new Context({ id: item.context, label: item.context })
        context.parent = this

        return context
      }
      return item.group && new Group(item.group, contexts, this)
    })
  }
}

class _Config {
  constructor(json) {
    const layers = json.layers.map(layerConf => new Layer(layerConf)),
          contexts = json.contexts.map(contextConf => new Context(contextConf, layers))

    this.groups = new Group(json.group, contexts, null)

    // Delete the contexts that are not in a group
    this.contexts = contexts.filter(c => this.groups.findById(c.id))

    // Delete the layers that are not in a context
    this.layers = layers.filter(l => this.contexts.some(c => c.layers.indexOf(l) !== -1))

    // // Mark layers that are not in a context (they will not be instantiated as OL layers)
    // this.layers.forEach(l => {
    //   if (this.contexts.some(c => c.layers.indexOf(l) !== -1)) l.hasContext = true
    // })
  }
}

export function getLayers(lang, cb) {
  return new Promise((resolve, reject) => {
    const url = api.baseUrl + api.getLayersConfigUrl
    httpRequest('GET', url)
      .then(responseText => resolve(new _Config(JSON.parse(responseText))))
      .catch(error => reject(error.statusText || error.message))
  })
}

function serializeConfiguration(groupConfig, layersRank) {
  // Gather all the contexts and layers
  // We are not using the layers array directly because we want to remove unused layers from the configuration
  const contextsConfig = groupConfig.recReduce((acc, current) => acc.concat(current), [])
  let layersConfig = groupConfig.recReduce((acc, current) => [].concat.apply(acc, current.layers), [])
  layersConfig = layersRank.map(id => layersConfig.find(l => l.id === id)).filter(x => x)

  // Clean up before exporting
  const layerReplacer = (key, value) => {
    switch (key) {
      case 'originalId': // TODO the originalId attribute will be removed
      case 'urls':
        return undefined
      case 'serverUrls':
        return value || undefined
      case 'legend':
      case 'sourceLink':
      case 'sourceLabel':
        return value || undefined
      case 'times':
        const t = value.map(t => t.iso8601)
        return t && t.length ? t : undefined
      case 'styles':
        // Delete style languages with no label (not localized)
        const styles = value.map(s => s.label ? s : null).filter(s => !!s)
        // Don't save the style array if it's empty
        return styles.length ? styles : undefined
      default:
        return value
    }
  }
  const layers = JSON.parse(JSON.stringify(layersConfig, layerReplacer))

  const contextReplacer = (key, value) => {
    switch (key) {
      case 'layers':
        return value.length ? value.map(l => l.id) : undefined
      case 'inlineLegendUrl':
      case 'infoFile':
        return value || undefined
      case 'parent':
      case 'hasLegends':
      case 'times':
      case 'originalId': // TODO the originalId attribute will be removed
        return undefined
      default:
        return value
    }
  }
  const contexts = JSON.parse(JSON.stringify(contextsConfig, contextReplacer))

  const groupReplacer = (key, value) => {
    switch (key) {
      case '': // Root
        // Remove the label attribute from the root
        return {
          exclusive: value.exclusive,
          items: value.items
        }
      case 'id':
      case 'parent':
        return undefined
      case 'infoFile':
        return value || undefined
      case 'items':
        if (value.length === 0) return undefined
        return value.map(item => item.isGroup ? { group: item } : { context: item.id })
      default:
        return value
    }
  }
  const group = JSON.parse(JSON.stringify(groupConfig, groupReplacer))

  const obj = {
    $schema: '../../layersJsonSchema_v2.json', // TODO
    layers: layers,
    contexts: contexts,
    group: group
  }

  return JSON.stringify(obj)
}

export function saveConfiguration(conf, layersRank) {
  const url = api.baseUrl + api.saveLayersConfigUrl
  return httpRequest('POST', url, serializeConfiguration(conf, layersRank), [['Content-Type', 'application/json'], ['Authorization', auth.getAuthToken()]])
}

export function getConfigurationHistory() {
  return new Promise((resolve, reject) => {
    const url = api.baseUrl + api.getLayersConfigHisoryUrl
    httpRequest('GET', url, null, [['Authorization', auth.getAuthToken()]])
      .then(responseText => resolve(JSON.parse(responseText)))
      .catch(error => reject(error))
  })
}

export function restoreVersion(version) {
  const url = api.baseUrl + api.restoreVersionUrl + '?version=' + version
  return httpRequest('GET', url, null, [['Authorization', auth.getAuthToken()]])
}
