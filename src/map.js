/* global ol */
import { map as mapConfig } from 'config'
/*
import MousePosition from 'ol/control/mouseposition'
import coordinate from 'ol/coordinate'
import control from 'ol/control'
import proj from 'ol/proj'
import View from 'ol/View'
import Map from 'ol/Map'
*/

const mousePositionControl = new ol.control.MousePosition({
  coordinateFormat: ol.coordinate.createStringXY(4),
  projection: 'EPSG:4326',
  undefinedHTML: '&nbsp;'
})

export default new ol.Map({
  controls: ol.control.defaults({
    attributionOptions: ({ collapsible: false })
  }).extend([mousePositionControl]),
  view: new ol.View({
    center: ol.proj.fromLonLat(mapConfig.mapCenterLonLat || [0, 0]),
    zoom: mapConfig.mapZoom || 4
  })
})
