#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Whisper Local - Transcripción local con GPU usando Faster-Whisper
Implementación para reemplazar la API de OpenAI con procesamiento local
"""

import os
import json
import tempfile
import shutil
from pathlib import Path
from typing import Optional, Dict, Any, List
import time

# Intentar añadir las rutas de las librerías de NVIDIA al PATH si existen
try:
    import site
    site_packages = site.getsitepackages()
    for path in site_packages:
        nvidia_path = os.path.join(path, 'nvidia')
        if os.path.exists(nvidia_path):
            for root, dirs, files in os.walk(nvidia_path):
                if 'bin' in dirs:
                    bin_path = os.path.join(root, 'bin')
                    os.environ['PATH'] = bin_path + os.pathsep + os.environ['PATH']
                    try:
                        os.add_dll_directory(bin_path)
                    except AttributeError:
                        pass # os.add_dll_directory solo disponible en Python 3.8+ Windows
except Exception:
    pass

FASTER_WHISPER_ERROR = None
try:
    from faster_whisper import WhisperModel
    import torch
    FASTER_WHISPER_AVAILABLE = True
except Exception as e:
    FASTER_WHISPER_AVAILABLE = False
    FASTER_WHISPER_ERROR = str(e)
    # No imprimimos nada aquí para no ensuciar la salida JSON si se importa como módulo

class WhisperLocal:
    """Clase para manejar transcripción local con Faster-Whisper"""
    
    def __init__(self):
        self.model = None
        self.model_size = "medium"  # Modelo por defecto
        self.device = "auto"        # auto, cpu, cuda
        self.compute_type = "auto"  # auto, float16, int8
        self.is_loaded = False
        
    def detect_device(self) -> str:
        """Detecta automáticamente el mejor dispositivo disponible"""
        if not FASTER_WHISPER_AVAILABLE:
            return "cpu"
            
        try:
            if torch.cuda.is_available():
                device_name = torch.cuda.get_device_name(0)
                memory_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
                # print(f"GPU detectada: {device_name} ({memory_gb:.1f} GB)") # Comentado para no ensuciar JSON
                return "cuda"
            else:
                # print("Usando CPU (GPU no disponible)")
                return "cpu"
        except Exception:
            return "cpu"
    
    def get_optimal_settings(self, device: str) -> Dict[str, str]:
        """Obtiene configuraciones óptimas según el dispositivo"""
        if device == "cuda":
            # Configuraciones optimizadas para GPU
            return {
                "device": "cuda",
                "compute_type": "float16",  # Más rápido en GPU moderna
                "model_size": "large-v3"    # Mejor calidad disponible
            }
        else:
            # Configuraciones optimizadas para CPU
            return {
                "device": "cpu", 
                "compute_type": "int8",     # Más eficiente en CPU
                "model_size": "medium"      # Balance velocidad/calidad
            }
    
    def load_model(self, model_size: Optional[str] = None, force_device: Optional[str] = None) -> bool:
        """
        Carga el modelo de Whisper
        
        Args:
            model_size: tiny, base, small, medium, large, large-v2, large-v3
            force_device: cuda, cpu, auto
        """
        if not FASTER_WHISPER_AVAILABLE:
            # print(f"❌ Faster-Whisper no está disponible: {FASTER_WHISPER_ERROR}")
            return False
        
        try:
            # Detectar dispositivo si no se especifica
            device = force_device if force_device and force_device != "auto" else self.detect_device()
            
            # Obtener configuraciones óptimas
            settings = self.get_optimal_settings(device)
            
            # Usar configuraciones óptimas o parámetros especificados
            final_model_size = model_size or settings["model_size"]
            final_device = force_device or settings["device"]
            final_compute_type = settings["compute_type"]
            
            # print(f"Cargando modelo Whisper '{final_model_size}' en {final_device}...")
            start_time = time.time()
            
            # Cargar modelo
            self.model = WhisperModel(
                final_model_size,
                device=final_device,
                compute_type=final_compute_type,
                download_root=os.path.join(os.getcwd(), "whisper_models")  # Carpeta local
            )
            
            load_time = time.time() - start_time
            # print(f"Modelo cargado en {load_time:.2f} segundos")
            
            # Guardar configuración actual
            self.model_size = final_model_size
            self.device = final_device
            self.compute_type = final_compute_type
            self.is_loaded = True
            
            return True
            
        except Exception as e:
            # print(f"Error cargando modelo: {e}")
            raise e # Re-lanzar para que el llamador lo maneje
    
    def transcribe_audio(self, audio_path: str, language: Optional[str] = None) -> Dict[str, Any]:
        """
        Transcribe un archivo de audio
        
        Args:
            audio_path: Ruta al archivo de audio
            language: Idioma del audio (es, en, fr, etc.) o None para detección automática
            
        Returns:
            Dict con transcript, language, duration, etc.
        """
        if not FASTER_WHISPER_AVAILABLE:
             return {
                "success": False,
                "error": f"Faster-Whisper no disponible: {FASTER_WHISPER_ERROR}"
            }

        if not self.is_loaded:
            # print("Modelo no cargado. Cargando modelo por defecto...")
            try:
                if not self.load_model():
                    return {
                        "success": False,
                        "error": "No se pudo cargar el modelo de Whisper"
                    }
            except Exception as e:
                return {
                    "success": False,
                    "error": f"Error cargando modelo: {str(e)}"
                }
        
        if not os.path.exists(audio_path):
            return {
                "success": False,
                "error": f"Archivo no encontrado: {audio_path}"
            }
        
        try:
            # print(f"Transcribiendo: {os.path.basename(audio_path)}")
            # print(f"Configuracion: {self.model_size} | {self.device} | {self.compute_type}")
            
            start_time = time.time()
            
            # Transcribir
            segments, info = self.model.transcribe(
                audio_path,
                language=language,
                beam_size=5,          # Mejor calidad
                best_of=5,           # Mejor calidad
                temperature=0.0,     # Determinístico
                condition_on_previous_text=False,  # Mejor para audio largo
                vad_filter=True,     # Filtro de detección de voz
                vad_parameters=dict(min_silence_duration_ms=500)  # Filtrar silencios
            )
            
            # Combinar todos los segmentos
            transcript_text = ""
            detailed_segments = []
            
            for segment in segments:
                transcript_text += segment.text
                detailed_segments.append({
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text.strip(),
                    "avg_logprob": segment.avg_logprob,
                    "no_speech_prob": segment.no_speech_prob
                })
            
            transcription_time = time.time() - start_time
            
            # Información del resultado
            result = {
                "success": True,
                "transcript": transcript_text.strip(),
                "language": info.language,
                "language_probability": info.language_probability,
                "duration": info.duration,
                "transcription_time": transcription_time,
                "model_info": {
                    "model_size": self.model_size,
                    "device": self.device,
                    "compute_type": self.compute_type
                },
                "segments": detailed_segments,
                "stats": {
                    "total_segments": len(detailed_segments),
                    "avg_confidence": sum(s["avg_logprob"] for s in detailed_segments) / len(detailed_segments) if detailed_segments else 0,
                    "processing_speed": info.duration / transcription_time if transcription_time > 0 else 0
                }
            }
            
            # print(f"Transcripcion completada en {transcription_time:.2f}s")
            # print(f"Velocidad: {result['stats']['processing_speed']:.1f}x tiempo real")
            # print(f"Idioma detectado: {info.language} ({info.language_probability:.1%})")
            
            return result
            
        except Exception as e:
            # print(f"Error en transcripcion: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def get_available_models(self) -> List[str]:
        """Retorna lista de modelos disponibles"""
        return [
            "tiny",      # ~39 MB  | ~32x realtime
            "tiny.en",   # ~39 MB  | ~32x realtime (solo inglés)
            "base",      # ~74 MB  | ~16x realtime  
            "base.en",   # ~74 MB  | ~16x realtime (solo inglés)
            "small",     # ~244 MB | ~6x realtime
            "small.en",  # ~244 MB | ~6x realtime (solo inglés)
            "medium",    # ~769 MB | ~2x realtime
            "medium.en", # ~769 MB | ~2x realtime (solo inglés)
            "large",     # ~1550 MB| ~1x realtime
            "large-v2",  # ~1550 MB| ~1x realtime (mejorado)
            "large-v3"   # ~1550 MB| ~1x realtime (más reciente)
        ]
    
    def get_model_info(self) -> Dict[str, Any]:
        """Retorna información del modelo actual"""
        return {
            "is_loaded": self.is_loaded,
            "model_size": self.model_size,
            "device": self.device,
            "compute_type": self.compute_type,
            "gpu_available": torch.cuda.is_available(),
            "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "available_models": self.get_available_models()
        }

# Instancia global
whisper_local = WhisperLocal()

def test_whisper_local():
    """Función de prueba para verificar que todo funciona"""
    # print("Probando Whisper Local...")
    
    # Mostrar información del sistema
    info = whisper_local.get_model_info()
    # print(f"GPU disponible: {info['gpu_available']}")
    if info['gpu_available']:
        print(f"GPU: {info['gpu_name']}")
    
    # Cargar modelo pequeño para prueba
    success = whisper_local.load_model("tiny")
    print(f"Carga de modelo: {'Exitosa' if success else 'Fallida'}")
    
    return success

if __name__ == "__main__":
    test_whisper_local()
