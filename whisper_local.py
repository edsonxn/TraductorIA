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
            raise RuntimeError(f"faster-whisper no está instalado. Ejecuta: pip install faster-whisper torch. Error: {FASTER_WHISPER_ERROR}")
        
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
            
            # Transcribir con word timestamps para detectar silencios internos
            segments, info = self.model.transcribe(
                audio_path,
                language=language,
                beam_size=5,          # Mejor calidad
                best_of=5,           # Mejor calidad
                temperature=0.0,     # Determinístico
                condition_on_previous_text=False,  # Mejor para audio largo
                vad_filter=True,     # Filtro de detección de voz
                vad_parameters=dict(min_silence_duration_ms=400),
                word_timestamps=True  # Timestamps por palabra para split en silencios
            )
            
            # Combinar todos los segmentos usando word timestamps
            # Estrategia: reagrupar palabras por ORACIONES COMPLETAS (cortar en . ? !)
            # y también forzar corte en silencios grandes entre palabras
            SILENCE_THRESHOLD = 1.2  # segundos de silencio entre palabras para forzar corte
            MAX_SEGMENT_DURATION = 15  # máximo de segundos por segmento
            
            # Primero, recopilar TODAS las palabras de todos los segmentos
            all_words = []
            for segment in segments:
                words = segment.words if hasattr(segment, 'words') and segment.words else None
                if words:
                    all_words.extend(words)
                elif segment.text.strip():
                    # Fallback: segmento sin words, crear pseudo-word
                    class PseudoWord:
                        def __init__(self, start, end, word):
                            self.start = start
                            self.end = end
                            self.word = word
                    all_words.append(PseudoWord(segment.start, segment.end, " " + segment.text.strip()))
            
            # Ahora reagrupar por oraciones completas
            transcript_text = ""
            detailed_segments = []
            
            if not all_words:
                # Sin palabras, usar transcript crudo
                transcript_text = ""
                for segment in segments:
                    transcript_text += segment.text
                    detailed_segments.append({
                        "start": segment.start,
                        "end": segment.end,
                        "text": segment.text.strip()
                    })
            else:
                current_words = []
                current_start = all_words[0].start
                
                for wi, word in enumerate(all_words):
                    # Detectar silencio grande ANTES de esta palabra
                    if wi > 0:
                        gap = word.start - all_words[wi - 1].end
                        if gap > SILENCE_THRESHOLD and current_words:
                            # Forzar corte por silencio
                            seg_text = "".join(w.word for w in current_words).strip()
                            if seg_text:
                                detailed_segments.append({
                                    "start": current_start,
                                    "end": current_words[-1].end,
                                    "text": seg_text
                                })
                                transcript_text += seg_text + " "
                            current_words = []
                            current_start = word.start
                    
                    current_words.append(word)
                    
                    # Verificar si esta palabra termina una oración
                    word_text = word.word.strip()
                    ends_sentence = word_text and word_text[-1] in '.?!。'
                    
                    # También cortar si el segmento es muy largo
                    segment_too_long = (word.end - current_start) > MAX_SEGMENT_DURATION
                    
                    if ends_sentence or segment_too_long:
                        seg_text = "".join(w.word for w in current_words).strip()
                        if seg_text:
                            detailed_segments.append({
                                "start": current_start,
                                "end": word.end,
                                "text": seg_text
                            })
                            transcript_text += seg_text + " "
                        current_words = []
                        # El start del siguiente segmento será el inicio de la siguiente palabra
                        if wi + 1 < len(all_words):
                            current_start = all_words[wi + 1].start
                
                # Cerrar último segmento si quedan palabras
                if current_words:
                    seg_text = "".join(w.word for w in current_words).strip()
                    if seg_text:
                        detailed_segments.append({
                            "start": current_start,
                            "end": current_words[-1].end,
                            "text": seg_text
                        })
                        transcript_text += seg_text + " "
            
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

def transcribe_cli():
    """CLI entry point: python whisper_local.py transcribe <audio_path> [language] [model_size]
    Outputs JSON result to stdout."""
    import sys
    import io
    # Force UTF-8 output on Windows
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Usage: whisper_local.py transcribe <audio_path> [language] [model_size]"}))
        sys.exit(1)
    
    audio_path = sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "auto" else None
    model_size = sys.argv[4] if len(sys.argv) > 4 else "large-v3"
    
    if not os.path.exists(audio_path):
        print(json.dumps({"success": False, "error": f"File not found: {audio_path}"}))
        sys.exit(1)
    
    try:
        whisper_local.load_model(model_size)
        result = whisper_local.transcribe_audio(audio_path, language=language)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "transcribe":
        transcribe_cli()
    else:
        test_whisper_local()
